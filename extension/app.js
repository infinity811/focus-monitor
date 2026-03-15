/* ══════════════════════════════════════════
   STATE
   ══════════════════════════════════════════ */
const S = {
  status: 'init',
  sessionStart: Date.now(),
  focusMs: 0, distMs: 0, awayMs: 0,
  blinks: 0, eyeOpen: true, lastBlink: 0,
  lastFace: Date.now(), lastChange: Date.now(),
  yaw: 0, pitch: 0,
  focusHist: [],
  tlData: Array(29).fill(null),
  curMinStart: Date.now(),
  breakShown: false,
  events: [], camOn: false, lastStateSwitch: 0,
  paused: false,

  /* Calibration */
  calibrated: false,
  calYaw: 0, calPitch: 0, calNoseY: 0, calFaceH: 0,
  calibSamples: [],

  /* Posture */
  noseYHistory: [],
  faceHeightHistory: [],
  postureBaseline: null,
  postureBad: false,
  postureBadSince: 0,
  postureAlertShown: false,
  lastPostureSound: 0,
  postureWasGood: true,
  distractedSince: 0,
  lastTickSound: 0,
  lookingAwaySince: 0,

  /* Drowsiness */
  earHistory: [],
  blinkTimestamps: [],
  longBlinkCount: 0,
  blinkStartTime: 0,
  drowsyAlertShown: false,

  /* Streaks */
  curStreakStart: 0,
  curStreakMs: 0,
  bestStreakMs: 0,
  streakCount: 0,
  inStreak: false,

  /* Tab visibility */
  tabVisibleMs: 0, tabHiddenMs: 0, tabSwitches: 0,
  tabLastChange: Date.now(), tabVisible: true,

  /* Audio */
  soundOn: false,

  /* Smart notifications */
  lastSmartNotif: 0,
  smartNotifShown: {},  /* track which notifs fired this session */
  lastFocusPct5min: 0,

  /* Pomo auto-pause */
  pomoAutoPaused: false,

  /* Daily goal */
  goalMin: 120,

  /* Per-hour focus tracking for heatmap */
  hourFocusMs: {},
};

/* ══════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════ */
let YAW_T = 35, PITCH_T = 30;
const AWAY_T = 3000;

/* Sensitivity presets: [yaw, pitch, label, delay] */
const SENS_PRESETS = [
  { name: 'Tight',     yaw: 20, pitch: 18, delay: 5000,  desc: '1 monitor, strict' },
  { name: 'Normal',    yaw: 35, pitch: 30, delay: 8000,  desc: '1-2 monitors' },
  { name: 'Wide',      yaw: 55, pitch: 40, delay: 10000, desc: '2-3 monitors' },
  { name: 'Ultra Wide',yaw: 75, pitch: 50, delay: 12000, desc: '3+ monitors / relaxed' },
];
let sensIdx = 1; /* default: Normal */
const BLINK_EAR = 0.22, BLINK_COOLDOWN = 350;
let STATE_COOLDOWN = 8000;

const LONG_BLINK_MS = 400;
const POSTURE_DROP_THRESHOLD = 0.04; /* 4% of frame height drop = slouching */
const DROWSY_BLINK_RATE = 22; /* blinks/min threshold */

/* MediaPipe landmark indices */
const LE_IDX = [362, 385, 387, 263, 373, 380];
const RE_IDX = [33,  160, 158, 133, 153, 144];
const NOSE = 1, CHIN = 175, LT = 234, RT = 454;
const FOREHEAD = 10; /* top of head landmark */

/* ══════════════════════════════════════════
   PERSISTENCE — localStorage
   ══════════════════════════════════════════ */
const STORE_KEY = 'focus_monitor_data';

function loadStore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (!d.days) d.days = {};
    if (!d.allTimeBestStreak) d.allTimeBestStreak = 0;
    if (!d.goalMin) d.goalMin = 120;
    return d;
  } catch { return { days: {}, allTimeBestStreak: 0, goalMin: 120 }; }
}

function saveStore(d) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch {}
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayData() {
  const store = loadStore();
  const key = todayKey();
  if (!store.days[key]) store.days[key] = { focusMs: 0, sessions: 0, bestStreak: 0, hourly: {} };
  return { store, today: store.days[key] };
}

function persistSession() {
  const { store, today } = getTodayData();
  today.focusMs += S.focusMs;
  today.sessions++;
  if (S.bestStreakMs > today.bestStreak) today.bestStreak = S.bestStreakMs;
  if (S.bestStreakMs > store.allTimeBestStreak) store.allTimeBestStreak = S.bestStreakMs;
  /* save hourly breakdown */
  const hour = new Date().getHours();
  if (!today.hourly[hour]) today.hourly[hour] = 0;
  today.hourly[hour] += S.focusMs;
  store.goalMin = S.goalMin;
  saveStore(store);
}

/* Save periodically */
setInterval(() => {
  const { store, today } = getTodayData();
  const hour = new Date().getHours();
  if (!today.hourly) today.hourly = {};
  if (!today.hourly[hour]) today.hourly[hour] = 0;
  /* save live per-hour focus data */
  Object.keys(S.hourFocusMs).forEach(h => {
    today.hourly[h] = S.hourFocusMs[h];
  });
  /* incremental save */
  today.focusMs_live = S.focusMs;
  today.bestStreak_live = S.bestStreakMs;
  if (S.bestStreakMs > (store.allTimeBestStreak || 0)) store.allTimeBestStreak = S.bestStreakMs;
  store.goalMin = S.goalMin;
  saveStore(store);
}, 30000);

/* Load goal from store */
(function initGoal() {
  const store = loadStore();
  if (store.goalMin) { S.goalMin = store.goalMin; }
  const inp = document.getElementById('goalInput');
  if (inp) inp.value = S.goalMin;
})();

/* Load sensitivity preset from store */
(function initSensitivity() {
  try {
    const saved = localStorage.getItem('focus_monitor_sensIdx');
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (idx >= 0 && idx < SENS_PRESETS.length) {
        sensIdx = idx;
        /* Apply without toast/event on startup */
        const p = SENS_PRESETS[sensIdx];
        YAW_T = p.yaw;
        PITCH_T = p.pitch;
        STATE_COOLDOWN = p.delay;
        const btn = document.getElementById('sensBtn');
        if (btn) {
          btn.textContent = 'Sens: ' + p.name;
          btn.classList.toggle('active', sensIdx >= 2);
        }
      }
    }
  } catch {}
})();

/* ══════════════════════════════════════════
   AUDIO CUES
   ══════════════════════════════════════════ */
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playTone(freq, duration, type = 'sine', vol = 0.08) {
  if (!S.soundOn) return;
  if (!audioCtx) audioCtx = new AudioCtx();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

function playFocusIn()  { playTone(880, 0.15); setTimeout(() => playTone(1100, 0.12), 100); }
function playFocusOut() { playTone(440, 0.2, 'triangle'); }
function playAlert()    { playTone(660, 0.1); setTimeout(() => playTone(660, 0.1), 150); setTimeout(() => playTone(880, 0.15), 300); }
function playPostureWarn() { playTone(300, 0.25, 'triangle', 0.1); setTimeout(() => playTone(250, 0.3, 'triangle', 0.08), 200); }
function playPostureGood() { playTone(600, 0.1, 'sine', 0.06); setTimeout(() => playTone(800, 0.1, 'sine', 0.05), 80); }

/* Subtle clock tick — white noise burst, very quiet */
function playTick() {
  if (!S.soundOn) return;
  if (!audioCtx) audioCtx = new AudioCtx();
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.02, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.15));
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.03;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 3000;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

function toggleSound() {
  S.soundOn = !S.soundOn;
  document.getElementById('soundBtn').textContent = 'Sound: ' + (S.soundOn ? 'ON' : 'OFF');
  document.getElementById('soundBtn').classList.toggle('active', S.soundOn);
  if (S.soundOn) {
    if (!audioCtx) audioCtx = new AudioCtx();
    playTone(700, 0.1, 'sine', 0.04);
  }
  showToast(S.soundOn ? 'Audio cues enabled' : 'Audio cues muted', 'info');
}

/* ══════════════════════════════════════════
   SENSITIVITY
   ══════════════════════════════════════════ */
function cycleSensitivity() {
  sensIdx = (sensIdx + 1) % SENS_PRESETS.length;
  applySensitivity();
  try { localStorage.setItem('focus_monitor_sensIdx', sensIdx); } catch {}
}

function applySensitivity() {
  const p = SENS_PRESETS[sensIdx];
  YAW_T = p.yaw;
  PITCH_T = p.pitch;
  STATE_COOLDOWN = p.delay;
  const btn = document.getElementById('sensBtn');
  btn.textContent = 'Sens: ' + p.name;
  btn.classList.toggle('active', sensIdx >= 2);
  showToast(`${p.name} — Yaw ±${p.yaw}° Pitch ±${p.pitch}° Delay ${p.delay/1000}s`, 'info');
  addEv('Sensitivity: ' + p.name + ' (' + p.desc + ')', 'i');
}

/* ══════════════════════════════════════════
   AMBIENT SOUNDS — Rain / Forest / Lofi
   ══════════════════════════════════════════ */
const AMB = { current: null, gainNode: null, nodes: [], vol: 0.4 };

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function stopAmbient() {
  AMB.nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch {} });
  AMB.nodes = [];
  if (AMB.gainNode) { AMB.gainNode.disconnect(); AMB.gainNode = null; }
  document.querySelectorAll('.amb-btn').forEach(b => b.classList.remove('playing'));
  AMB.current = null;
}

function toggleAmbient(type) {
  if (AMB.current === type) { stopAmbient(); showToast('Ambient off', 'info'); return; }
  stopAmbient();
  AMB.current = type;
  document.getElementById('amb' + type.charAt(0).toUpperCase() + type.slice(1)).classList.add('playing');

  const ctx = getAudioCtx();
  AMB.gainNode = ctx.createGain();
  AMB.gainNode.gain.value = AMB.vol;
  AMB.gainNode.connect(ctx.destination);

  if (type === 'rain') createRain(ctx);
  else if (type === 'forest') createForest(ctx);
  else if (type === 'lofi') createLofi(ctx);

  showToast(type.charAt(0).toUpperCase() + type.slice(1) + ' playing', 'success');
}

function setAmbientVol(v) {
  AMB.vol = v / 100;
  if (AMB.gainNode) AMB.gainNode.gain.setTargetAtTime(AMB.vol, audioCtx.currentTime, 0.1);
}

/* ── RAIN ── */
function createRain(ctx) {
  /* Base rain: brown noise (filtered white noise) */
  const bufSize = 2 * ctx.sampleRate;
  const buf = ctx.createBuffer(2, bufSize, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886*b0 + w*0.0555179;
      b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520;
      b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522;
      b5 = -0.7616*b5 - w*0.0168980;
      data[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362) * 0.06;
      b6 = w * 0.115926;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 800;
  src.connect(lp); lp.connect(AMB.gainNode);
  src.start();
  AMB.nodes.push(src);

  /* Heavy drops layer */
  const dropBuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const dd = dropBuf.getChannelData(0);
  for (let i = 0; i < dd.length; i++) {
    /* Sparse random plinks */
    dd[i] = Math.random() < 0.001 ? (Math.random() * 2 - 1) * 0.8 * Math.exp(-((i % 400) / 80)) : 0;
  }
  const dropSrc = ctx.createBufferSource();
  dropSrc.buffer = dropBuf; dropSrc.loop = true;
  const dropHp = ctx.createBiquadFilter();
  dropHp.type = 'highpass'; dropHp.frequency.value = 2000;
  const dropGain = ctx.createGain();
  dropGain.gain.value = 0.3;
  dropSrc.connect(dropHp); dropHp.connect(dropGain); dropGain.connect(AMB.gainNode);
  dropSrc.start();
  AMB.nodes.push(dropSrc);
}

/* ── FOREST ── */
function createForest(ctx) {
  /* Wind base: filtered pink noise */
  const bufSize = 2 * ctx.sampleRate;
  const buf = ctx.createBuffer(2, bufSize, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let b0=0,b1=0,b2=0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997*b0 + w*0.029;
      b1 = 0.985*b1 + w*0.032;
      b2 = 0.950*b2 + w*0.048;
      data[i] = (b0+b1+b2) * 0.15;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 0.5;
  src.connect(bp); bp.connect(AMB.gainNode);
  src.start();
  AMB.nodes.push(src);

  /* Wind modulation — slow LFO on volume for breathing effect */
  const windGain = ctx.createGain();
  windGain.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine'; lfo.frequency.value = 0.15;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.3;
  lfo.connect(lfoGain); lfoGain.connect(windGain.gain);
  bp.disconnect(); bp.connect(windGain); windGain.connect(AMB.gainNode);
  lfo.start();
  AMB.nodes.push(lfo);

  /* Birds — periodic chirps */
  function scheduleBird() {
    if (AMB.current !== 'forest') return;
    const delay = 2 + Math.random() * 5;
    setTimeout(() => {
      if (AMB.current !== 'forest') return;
      const ac = getAudioCtx();
      const baseFreq = 2000 + Math.random() * 2000;
      const chirps = 1 + Math.floor(Math.random() * 4);
      for (let c = 0; c < chirps; c++) {
        const osc = ac.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(baseFreq + Math.random() * 500, ac.currentTime + c * 0.12);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * (0.8 + Math.random() * 0.5), ac.currentTime + c * 0.12 + 0.08);
        const g = ac.createGain();
        g.gain.setValueAtTime(0, ac.currentTime + c * 0.12);
        g.gain.linearRampToValueAtTime(0.04 + Math.random() * 0.03, ac.currentTime + c * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + c * 0.12 + 0.1);
        /* Pan randomly L/R */
        const pan = ac.createStereoPanner();
        pan.pan.value = Math.random() * 2 - 1;
        osc.connect(g); g.connect(pan); pan.connect(AMB.gainNode);
        osc.start(ac.currentTime + c * 0.12);
        osc.stop(ac.currentTime + c * 0.12 + 0.12);
      }
      scheduleBird();
    }, delay * 1000);
  }
  scheduleBird();
  /* Second bird species */
  function scheduleBird2() {
    if (AMB.current !== 'forest') return;
    const delay = 4 + Math.random() * 8;
    setTimeout(() => {
      if (AMB.current !== 'forest') return;
      const ac = getAudioCtx();
      const f = 1200 + Math.random() * 800;
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, ac.currentTime);
      osc.frequency.linearRampToValueAtTime(f * 1.5, ac.currentTime + 0.2);
      osc.frequency.linearRampToValueAtTime(f * 0.9, ac.currentTime + 0.5);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, ac.currentTime);
      g.gain.linearRampToValueAtTime(0.025, ac.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
      const pan = ac.createStereoPanner();
      pan.pan.value = Math.random() * 2 - 1;
      osc.connect(g); g.connect(pan); pan.connect(AMB.gainNode);
      osc.start(); osc.stop(ac.currentTime + 0.55);
      scheduleBird2();
    }, delay * 1000);
  }
  scheduleBird2();
}

/* ── LOFI ── */
function createLofi(ctx) {
  /* Lofi: warm chord loop + vinyl crackle + tape wobble */

  /* Chord progression: Cmaj7 → Am7 → Fmaj7 → G7 */
  const chords = [
    [261.6, 329.6, 392.0, 493.9],  /* Cmaj7 */
    [220.0, 261.6, 329.6, 392.0],  /* Am7 */
    [174.6, 220.0, 261.6, 329.6],  /* Fmaj7 */
    [196.0, 246.9, 293.7, 349.2],  /* G7 */
  ];

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.6;

  /* Warm low-pass for that lofi feel */
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'lowpass'; warmth.frequency.value = 900; warmth.Q.value = 1.5;

  /* Tape wobble via delay modulation */
  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = 0.02;
  const wobble = ctx.createOscillator();
  wobble.type = 'sine'; wobble.frequency.value = 0.4;
  const wobbleGain = ctx.createGain();
  wobbleGain.gain.value = 0.003;
  wobble.connect(wobbleGain); wobbleGain.connect(delay.delayTime);
  wobble.start();
  AMB.nodes.push(wobble);

  masterGain.connect(warmth);
  warmth.connect(delay);
  delay.connect(AMB.gainNode);

  /* Also direct signal (mix dry + wet) */
  const dryGain = ctx.createGain();
  dryGain.gain.value = 0.7;
  warmth.connect(dryGain);
  dryGain.connect(AMB.gainNode);

  let chordIdx = 0;
  function playChord() {
    if (AMB.current !== 'lofi') return;
    const ac = getAudioCtx();
    const notes = chords[chordIdx % chords.length];
    const chordDur = 2.4;

    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      /* Alternate between warm timbres */
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      /* Slight detune for warmth */
      osc.frequency.value = freq;
      osc.detune.value = (Math.random() - 0.5) * 12;

      const g = ac.createGain();
      const vol = 0.04 + (i === 0 ? 0.02 : 0);
      g.gain.setValueAtTime(0, ac.currentTime);
      g.gain.linearRampToValueAtTime(vol, ac.currentTime + 0.08);
      g.gain.setValueAtTime(vol, ac.currentTime + chordDur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + chordDur);

      osc.connect(g); g.connect(masterGain);
      osc.start(); osc.stop(ac.currentTime + chordDur + 0.1);
    });

    /* Kick-ish thump on beats 1 and 3 */
    [0, chordDur / 2].forEach(offset => {
      const kick = ac.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(120, ac.currentTime + offset);
      kick.frequency.exponentialRampToValueAtTime(40, ac.currentTime + offset + 0.15);
      const kg = ac.createGain();
      kg.gain.setValueAtTime(0.1, ac.currentTime + offset);
      kg.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + offset + 0.2);
      kick.connect(kg); kg.connect(AMB.gainNode);
      kick.start(ac.currentTime + offset);
      kick.stop(ac.currentTime + offset + 0.25);
    });

    /* Hi-hat noise on offbeats */
    [chordDur * 0.25, chordDur * 0.75].forEach(offset => {
      const hatBuf = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate);
      const hd = hatBuf.getChannelData(0);
      for (let i = 0; i < hd.length; i++) hd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (hd.length * 0.1));
      const hat = ac.createBufferSource();
      hat.buffer = hatBuf;
      const hg = ac.createGain();
      hg.gain.value = 0.03;
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 6000;
      hat.connect(hp); hp.connect(hg); hg.connect(AMB.gainNode);
      hat.start(ac.currentTime + offset);
    });

    chordIdx++;
    setTimeout(playChord, chordDur * 1000);
  }
  playChord();

  /* Vinyl crackle layer */
  const crackleLen = 4 * ctx.sampleRate;
  const crackleBuf = ctx.createBuffer(1, crackleLen, ctx.sampleRate);
  const cd = crackleBuf.getChannelData(0);
  for (let i = 0; i < crackleLen; i++) {
    cd[i] = Math.random() < 0.003 ? (Math.random() * 2 - 1) * 0.5 : (Math.random() * 2 - 1) * 0.005;
  }
  const crackle = ctx.createBufferSource();
  crackle.buffer = crackleBuf; crackle.loop = true;
  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0.15;
  const crackleHp = ctx.createBiquadFilter();
  crackleHp.type = 'highpass'; crackleHp.frequency.value = 1000;
  crackle.connect(crackleHp); crackleHp.connect(crackleGain); crackleGain.connect(AMB.gainNode);
  crackle.start();
  AMB.nodes.push(crackle);
}

/* ══════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  /* Clear old toast first, then show new one after brief transition */
  if (el.classList.contains('show')) {
    el.classList.remove('show');
    toastTimer = setTimeout(() => {
      el.textContent = msg;
      el.className = 'toast ' + type + ' show';
      toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
    }, 150);
  } else {
    el.textContent = msg;
    el.className = 'toast ' + type + ' show';
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }
}

/* ══════════════════════════════════════════
   MATH HELPERS
   ══════════════════════════════════════════ */
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function eyeAspectRatio(lm, idx) {
  const p = idx.map(i => lm[i]);
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]) + 1e-6);
}

function headPose(lm) {
  const nose = lm[NOSE], lt = lm[LT], rt = lm[RT], chin = lm[CHIN];
  const le = lm[RE_IDX[0]], re = lm[LE_IDX[0]];
  const eyeMidX = (le.x + re.x) / 2;
  const eyeMidY = (le.y + re.y) / 2;
  const tMid    = (lt.x + rt.x) / 2;
  const tSpan   = Math.abs(rt.x - lt.x);
  const yaw     = (nose.x - tMid) / (tSpan / 2 + 1e-6) * 45;
  const fh      = Math.abs(chin.y - eyeMidY);
  const pitch   = ((nose.y - eyeMidY) / (fh + 1e-6) - 0.38) * 100;
  return { yaw, pitch, noseY: nose.y, faceH: fh };
}

/* ══════════════════════════════════════════
   CALIBRATION
   ══════════════════════════════════════════ */
let calibTimer = null;
function startCalibration() {
  if (S.status === 'init' || !S.camOn) { showToast('Start camera first', 'info'); return; }
  const overlay = document.getElementById('calibOverlay');
  overlay.classList.add('on');
  S.calibSamples = [];
  let count = 3;
  document.getElementById('calibCountdown').textContent = count;
  addEv('Calibration started — hold still', 'i');

  clearInterval(calibTimer);
  calibTimer = setInterval(() => {
    count--;
    if (count > 0) {
      document.getElementById('calibCountdown').textContent = count;
    } else {
      clearInterval(calibTimer);
      finishCalibration();
    }
  }, 1000);
}

function finishCalibration() {
  const overlay = document.getElementById('calibOverlay');
  overlay.classList.remove('on');

  if (S.calibSamples.length < 5) {
    if (S.calibSamples.length === 0) {
      addEv('Calibration failed — no face detected', 'b');
      showToast('No face detected — check camera and lighting', 'info');
    } else {
      addEv('Calibration failed — only ' + S.calibSamples.length + ' samples', 'b');
      showToast('Not enough data (' + S.calibSamples.length + '/5 samples), try again', 'info');
    }
    return;
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  S.calYaw = avg(S.calibSamples.map(s => s.yaw));
  S.calPitch = avg(S.calibSamples.map(s => s.pitch));
  S.calNoseY = avg(S.calibSamples.map(s => s.noseY));
  S.calFaceH = avg(S.calibSamples.map(s => s.faceH));
  S.calibrated = true;

  /* Set posture baseline */
  S.postureBaseline = S.calNoseY;

  document.getElementById('calibStatus').textContent = 'calibrated';
  document.getElementById('calibStatus').style.color = 'var(--green)';
  document.getElementById('calibBtn').classList.add('active');

  addEv(`Calibrated: yaw=${S.calYaw.toFixed(1)}° pitch=${S.calPitch.toFixed(1)}°`, 'g');
  showToast('Calibration complete!', 'success');
  playTone(880, 0.12);
}

/* ══════════════════════════════════════════
   DRAWING
   ══════════════════════════════════════════ */
function drawOverlay(ctx, lm, w, h) {
  const pts = [...LE_IDX, ...RE_IDX, NOSE, LT, RT, CHIN, FOREHEAD];
  ctx.fillStyle = 'rgba(239,159,39,0.7)';
  pts.forEach(i => {
    const p = lm[i];
    ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 1.8, 0, Math.PI * 2); ctx.fill();
  });
  ctx.strokeStyle = 'rgba(239,159,39,0.4)'; ctx.lineWidth = 1;
  [LE_IDX, RE_IDX].forEach(eye => {
    ctx.beginPath();
    eye.forEach((i, j) => {
      const p = lm[i];
      j === 0 ? ctx.moveTo(p.x * w, p.y * h) : ctx.lineTo(p.x * w, p.y * h);
    });
    ctx.closePath(); ctx.stroke();
  });
  /* Draw posture line if calibrated */
  if (S.calibrated && S.postureBaseline) {
    const by = S.postureBaseline * h;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(91,155,213,0.3)';
    ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(w, by); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ══════════════════════════════════════════
   POSTURE DETECTION
   ══════════════════════════════════════════ */
function updatePosture(noseY, faceH) {
  S.noseYHistory.push(noseY);
  S.faceHeightHistory.push(faceH);
  if (S.noseYHistory.length > 150) S.noseYHistory.shift();
  if (S.faceHeightHistory.length > 150) S.faceHeightHistory.shift();

  if (!S.calibrated || !S.postureBaseline) {
    document.getElementById('postureScore').textContent = '—';
    document.getElementById('postureText').textContent = 'calibrate first';
    document.getElementById('faceYPos').textContent = (noseY * 100).toFixed(0) + '%';
    return;
  }

  const drift = noseY - S.postureBaseline;
  const driftPct = drift; /* positive = head dropped = slouching */
  const tag = document.getElementById('postureTag');

  document.getElementById('faceYPos').textContent = (drift * 100).toFixed(1) + '%';

  if (driftPct > POSTURE_DROP_THRESHOLD) {
    /* Slouching */
    const severity = Math.min(driftPct / 0.1, 1); /* 0-1 scale */
    const score = Math.max(0, Math.round((1 - severity) * 100));
    document.getElementById('postureScore').textContent = score + '%';
    document.getElementById('postureScore').style.color = score > 50 ? 'var(--amber)' : 'var(--red-d)';
    document.getElementById('postureText').textContent = 'slouching';
    document.getElementById('faceYText').textContent = 'below baseline';
    document.getElementById('faceYPos').style.color = 'var(--red-d)';
    tag.textContent = 'SLOUCHING'; tag.className = 'posture-indicator bad'; tag.style.display = 'block';
    document.getElementById('cPosture').textContent = score + '%';
    document.getElementById('cPosture').style.color = 'var(--red-d)';

    if (!S.postureBad) { S.postureBad = true; S.postureBadSince = Date.now(); S.postureWasGood = false; playPostureWarn(); S.lastPostureSound = Date.now(); }
    /* Nag every 10s while slouching */
    if (Date.now() - S.lastPostureSound > 10000) { playPostureWarn(); S.lastPostureSound = Date.now(); }
    if (!S.postureAlertShown && Date.now() - S.postureBadSince > 30000) {
      document.getElementById('postureBanner').classList.add('on');
      S.postureAlertShown = true;
      addEv('Posture alert — slouching for 30s+', 'w');
      playAlert();
    }
  } else if (driftPct < -POSTURE_DROP_THRESHOLD) {
    /* Leaning back / too high */
    document.getElementById('postureScore').textContent = '80%';
    document.getElementById('postureScore').style.color = 'var(--amber)';
    document.getElementById('postureText').textContent = 'leaning back';
    document.getElementById('faceYText').textContent = 'above baseline';
    document.getElementById('faceYPos').style.color = 'var(--amber)';
    tag.textContent = 'LEANING BACK'; tag.className = 'posture-indicator warn'; tag.style.display = 'block';
    document.getElementById('cPosture').textContent = '80%';
    document.getElementById('cPosture').style.color = 'var(--amber)';
    S.postureBad = false;
  } else {
    /* Good posture */
    document.getElementById('postureScore').textContent = '100%';
    document.getElementById('postureScore').style.color = 'var(--green)';
    document.getElementById('postureText').textContent = 'good';
    document.getElementById('faceYText').textContent = 'on baseline';
    document.getElementById('faceYPos').style.color = 'var(--green)';
    tag.textContent = 'GOOD POSTURE'; tag.className = 'posture-indicator'; tag.style.display = 'block';
    document.getElementById('cPosture').textContent = '100%';
    document.getElementById('cPosture').style.color = 'var(--green)';
    if (S.postureBad && !S.postureWasGood) { playPostureGood(); S.postureWasGood = true; }
    S.postureBad = false; S.postureAlertShown = false;
  }
}

function dismissPosture() {
  document.getElementById('postureBanner').classList.remove('on');
  S.postureAlertShown = false;
  S.postureBadSince = Date.now();
  addEv('Posture alert dismissed', 'g');
}

/* ══════════════════════════════════════════
   DROWSINESS DETECTION
   ══════════════════════════════════════════ */
function updateDrowsiness(ear, now) {
  S.earHistory.push({ t: now, v: ear });
  /* Keep 2 minutes of EAR data */
  while (S.earHistory.length > 0 && now - S.earHistory[0].t > 120000) S.earHistory.shift();

  /* Blink rate (per minute, last 60s) */
  const recentBlinks = S.blinkTimestamps.filter(t => now - t < 60000);
  const blinkRate = recentBlinks.length;

  /* Average EAR */
  const avgEar = S.earHistory.length > 0
    ? S.earHistory.reduce((s, e) => s + e.v, 0) / S.earHistory.length
    : 0.3;

  /* Drowsiness score: 0 (alert) to 100 (very drowsy) */
  let drowsyScore = 0;
  /* High blink rate contributes */
  if (blinkRate > 15) drowsyScore += Math.min((blinkRate - 15) / 15 * 40, 40);
  /* Low average EAR contributes */
  if (avgEar < 0.28) drowsyScore += Math.min((0.28 - avgEar) / 0.1 * 30, 30);
  /* Long blinks contribute */
  drowsyScore += Math.min(S.longBlinkCount * 8, 30);
  drowsyScore = Math.min(Math.round(drowsyScore), 100);

  /* Update UI */
  document.getElementById('blinkRate').textContent = blinkRate;
  document.getElementById('avgEAR').textContent = (avgEar * 100).toFixed(0);
  document.getElementById('longBlinks').textContent = S.longBlinkCount;

  const fill = document.getElementById('drowsyFill');
  const lbl = document.getElementById('drowsyLbl');
  fill.style.width = drowsyScore + '%';

  let alertText, alertColor;
  if (drowsyScore < 25) {
    alertText = 'Alert'; alertColor = 'var(--green)';
  } else if (drowsyScore < 50) {
    alertText = 'Mild'; alertColor = 'var(--amber)';
  } else if (drowsyScore < 75) {
    alertText = 'Drowsy'; alertColor = 'var(--red)';
  } else {
    alertText = 'Very Drowsy'; alertColor = 'var(--red-d)';
  }
  fill.style.background = alertColor;
  lbl.textContent = alertText;
  lbl.style.color = alertColor;
  document.getElementById('alertScore').textContent = (100 - drowsyScore) + '%';
  document.getElementById('alertScore').style.color = alertColor;
  document.getElementById('alertText').textContent = alertText.toLowerCase();

  /* Alert at 60+ */
  if (drowsyScore >= 60 && !S.drowsyAlertShown) {
    document.getElementById('drowsyBanner').classList.add('on');
    S.drowsyAlertShown = true;
    addEv('Drowsiness detected — take a break', 'w');
    playAlert();
  }
}

function dismissDrowsy() {
  document.getElementById('drowsyBanner').classList.remove('on');
  S.drowsyAlertShown = false;
  S.longBlinkCount = 0;
  addEv('Drowsiness alert dismissed', 'g');
}

/* ══════════════════════════════════════════
   STREAKS
   ══════════════════════════════════════════ */
function updateStreaks(now, focused) {
  if (focused && S.status === 'active') {
    if (!S.inStreak) {
      S.inStreak = true;
      S.curStreakStart = now;
      S.streakCount++;
    }
    S.curStreakMs = now - S.curStreakStart;
    if (S.curStreakMs > S.bestStreakMs) S.bestStreakMs = S.curStreakMs;
  } else {
    if (S.inStreak) S.inStreak = false;
    S.curStreakMs = 0;
  }

  document.getElementById('curStreak').textContent = fmtMsShort(S.curStreakMs);
  document.getElementById('bestStreak').textContent = fmtMsShort(S.bestStreakMs);
  document.getElementById('streakCount').textContent = S.streakCount;
  document.getElementById('mStreak').textContent = fmtMs(S.curStreakMs);

  /* All-time from store */
  const store = loadStore();
  const allTime = Math.max(store.allTimeBestStreak || 0, S.bestStreakMs);
  document.getElementById('allTimeBest').textContent = fmtMsShort(allTime);
}

/* ══════════════════════════════════════════
   FACE DETECTED
   ══════════════════════════════════════════ */
function onFace(lm) {
  if (S.paused) return;
  const now = Date.now();
  S.lastFace = now;

  const { yaw: rawYaw, pitch: rawPitch, noseY, faceH } = headPose(lm);

  /* Apply calibration offset */
  const yaw = S.calibrated ? rawYaw - S.calYaw : rawYaw;
  const pitch = S.calibrated ? rawPitch - S.calPitch : rawPitch;
  S.yaw = yaw; S.pitch = pitch;

  /* Collect calibration samples */
  if (document.getElementById('calibOverlay').classList.contains('on')) {
    S.calibSamples.push({ yaw: rawYaw, pitch: rawPitch, noseY, faceH });
  }

  /* EAR & blink detection */
  const le = eyeAspectRatio(lm, LE_IDX);
  const re = eyeAspectRatio(lm, RE_IDX);
  const e  = (le + re) / 2;

  if (e < BLINK_EAR && S.eyeOpen) {
    S.eyeOpen = false;
    S.blinkStartTime = now;
  } else if (e >= BLINK_EAR && !S.eyeOpen) {
    S.eyeOpen = true;
    if (now - S.lastBlink > BLINK_COOLDOWN) {
      S.blinks++;
      S.lastBlink = now;
      S.blinkTimestamps.push(now);
      /* Detect long blinks */
      if (S.blinkStartTime && now - S.blinkStartTime > LONG_BLINK_MS) {
        S.longBlinkCount++;
      }
    }
  }
  /* Clean old blink timestamps */
  while (S.blinkTimestamps.length > 0 && now - S.blinkTimestamps[0] > 120000) S.blinkTimestamps.shift();

  /* Focus classification */
  const focused = Math.abs(yaw) < YAW_T && Math.abs(pitch) < PITCH_T;
  const dt = now - S.lastChange;

  if (focused) {
    S.lookingAwaySince = 0; /* reset distracted timer */
    if (S.status !== 'active') {
      /* Snap back to focused IMMEDIATELY */
      if (S.status === 'distracted') S.distMs += dt;
      else if (S.status === 'away')  S.awayMs += dt;
      setStatus('active'); S.lastStateSwitch = now;
      S.distractedSince = 0;
      addEv('Returned to focus', 'g');
      playFocusIn();
    } else { addFocusMs(dt); }
  } else {
    if (S.status !== 'distracted') {
      /* Track how long we've been looking away */
      if (!S.lookingAwaySince) S.lookingAwaySince = now;
      /* Only switch to distracted after STATE_COOLDOWN */
      if (now - S.lookingAwaySince > STATE_COOLDOWN) {
        if (S.status === 'active') addFocusMs(dt);
        else if (S.status === 'away') S.awayMs += dt;
        setStatus('distracted'); S.lastStateSwitch = now;
        S.distractedSince = now;
        addEv('Head turned away', 'w');
        playFocusOut();
      } else if (S.status === 'active') { addFocusMs(dt); }
    } else { S.distMs += dt; }
  }
  S.lastChange = now;

  S.focusHist.push({ t: now, f: focused });
  if (S.focusHist.length > 3600) S.focusHist.shift();

  /* Update raw stats */
  document.getElementById('cYaw').textContent   = yaw.toFixed(1) + '°';
  document.getElementById('cPitch').textContent = pitch.toFixed(1) + '°';
  document.getElementById('cBlinks').textContent = S.blinks;
  document.getElementById('cEAR').textContent   = (e * 100).toFixed(0);
  updatePose(yaw, pitch);

  /* Posture */
  updatePosture(noseY, faceH);

  /* Drowsiness */
  updateDrowsiness(e, now);

  /* Streaks */
  updateStreaks(now, focused);
}

/* ══════════════════════════════════════════
   NO FACE
   ══════════════════════════════════════════ */
function onMissing() {
  if (S.paused) return;
  const now = Date.now();
  if (now - S.lastFace > AWAY_T) {
    const dt = now - S.lastChange;
    if (S.status === 'active') addFocusMs(dt);
    else if (S.status === 'distracted') S.distMs += dt;
    else if (S.status === 'away') S.awayMs += dt;
    if (S.status !== 'away') { setStatus('away'); addEv('Left desk / face not visible', 'b'); }
    S.lastChange = now;
    if (S.inStreak) { S.inStreak = false; S.curStreakMs = 0; }
  }
  ['cYaw','cPitch','cEAR'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('postureTag').style.display = 'none';
}

/* ══════════════════════════════════════════
   STATUS PILL
   ══════════════════════════════════════════ */
function setStatus(st) {
  S.status = st;
  const cfg = {
    init:       { bg:'var(--bg3)',       tc:'var(--muted)',   dc:'var(--muted)',   lbl:'INIT'       },
    active:     { bg:'var(--green-bg)',  tc:'var(--green)',   dc:'var(--green)',   lbl:'FOCUSED'    },
    distracted: { bg:'var(--amber-bg)',  tc:'var(--amber)',   dc:'var(--amber)',   lbl:'DISTRACTED' },
    away:       { bg:'var(--red-bg)',    tc:'var(--red-d)',   dc:'var(--red-d)',   lbl:'AWAY'       },
    err:        { bg:'var(--red-bg)',    tc:'var(--red-d)',   dc:'var(--red-d)',   lbl:'NO CAM'     },
    paused:     { bg:'var(--bg3)',       tc:'var(--muted)',   dc:'var(--muted)',   lbl:'PAUSED'     },
  };
  const c = cfg[st] || cfg.init;
  const pill = document.getElementById('sPill');
  pill.style.background = c.bg; pill.style.color = c.tc; pill.style.borderColor = c.dc;
  document.getElementById('sDot').style.background = c.dc;
  document.getElementById('sTxt').textContent = c.lbl;
  document.getElementById('sBadge').textContent = c.lbl;
  document.getElementById('sBadge').style.color = c.dc;
}

/* ══════════════════════════════════════════
   POSE GAUGES
   ══════════════════════════════════════════ */
function updatePose(yaw, pitch) {
  const yFoc = Math.abs(yaw) < YAW_T;
  const pFoc = Math.abs(pitch) < PITCH_T;
  const yCol = yFoc ? 'var(--green)' : 'var(--red-d)';
  const pCol = pFoc ? 'var(--green)' : 'var(--red-d)';

  const yPct = Math.min(Math.abs(yaw) / 60 * 50, 50);
  const yb = document.getElementById('yBar');
  yb.style.background = yCol; yb.style.top = '0'; yb.style.bottom = '0';
  if (yaw >= 0) { yb.style.left = '50%'; yb.style.width = yPct + '%'; }
  else          { yb.style.left = (50 - yPct) + '%'; yb.style.width = yPct + '%'; }
  document.getElementById('yLbl').textContent = yaw.toFixed(1) + '°';
  document.getElementById('yLbl').style.color = yCol;
  document.getElementById('yZone').textContent = yFoc ? 'on target' : (yaw > 0 ? 'looking right' : 'looking left');

  const pPct = Math.min(Math.abs(pitch) / 60 * 50, 50);
  const pb = document.getElementById('pBar');
  pb.style.background = pCol; pb.style.top = '0'; pb.style.bottom = '0';
  if (pitch >= 0) { pb.style.left = '50%'; pb.style.width = pPct + '%'; }
  else            { pb.style.left = (50 - pPct) + '%'; pb.style.width = pPct + '%'; }
  document.getElementById('pLbl').textContent = pitch.toFixed(1) + '°';
  document.getElementById('pLbl').style.color = pCol;
  document.getElementById('pZone').textContent = pFoc ? 'on target' : (pitch > 0 ? 'looking down' : 'looking up');
}

/* ══════════════════════════════════════════
   EVENTS
   ══════════════════════════════════════════ */
function addEv(msg, type) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  S.events.unshift({ t, msg, type });
  if (S.events.length > 50) S.events.pop();
  document.getElementById('evList').innerHTML = S.events
    .map(e => `<div class="ev"><span class="ev-t">${e.t}</span><span class="ev-${e.type}">${e.msg}</span></div>`)
    .join('');
}

/* ══════════════════════════════════════════
   FORMAT
   ══════════════════════════════════════════ */
function addFocusMs(dt) {
  S.focusMs += dt;
  const h = new Date().getHours();
  S.hourFocusMs[h] = (S.hourFocusMs[h] || 0) + dt;
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h > 0
    ? `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

function fmtMsShort(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ══════════════════════════════════════════
   BREAK BANNER
   ══════════════════════════════════════════ */
function dismissBreak() {
  document.getElementById('brkBanner').classList.remove('on');
  S.breakShown = false;
}

/* ══════════════════════════════════════════
   POMODORO TIMER
   ══════════════════════════════════════════ */
const POMO = {
  workMin: 25, shortMin: 5, longMin: 15, rounds: 4,
  state: 'idle',   /* idle, work, short, long */
  running: false,
  remainMs: 25 * 60 * 1000,
  totalMs: 25 * 60 * 1000,
  round: 1,
  completed: 0,
  totalFocusMs: 0,
  lastTick: 0,
  autoStart: true,
};

function pomoUpdateSettings() {
  POMO.workMin  = Math.max(1, Math.min(90, parseInt(document.getElementById('pomoWorkInput').value) || 25));
  POMO.shortMin = Math.max(1, Math.min(30, parseInt(document.getElementById('pomoShortInput').value) || 5));
  POMO.longMin  = Math.max(5, Math.min(60, parseInt(document.getElementById('pomoLongInput').value) || 15));
  POMO.rounds   = Math.max(2, Math.min(8, parseInt(document.getElementById('pomoRoundsInput').value) || 4));
  if (POMO.state === 'idle') {
    POMO.remainMs = POMO.workMin * 60 * 1000;
    POMO.totalMs = POMO.remainMs;
    pomoRenderTime();
  }
  pomoRenderDots();
}

function pomoToggle() {
  if (POMO.state === 'idle') {
    /* Start first work session */
    POMO.state = 'work';
    POMO.running = true;
    POMO.remainMs = POMO.workMin * 60 * 1000;
    POMO.totalMs = POMO.remainMs;
    POMO.lastTick = Date.now();
    POMO.round = 1;
    addEv('Pomodoro started — round 1/' + POMO.rounds, 'g');
    playTone(600, 0.1); setTimeout(() => playTone(800, 0.12), 100);
  } else if (POMO.running) {
    /* Pause */
    POMO.running = false;
    addEv('Pomodoro paused', 'i');
  } else {
    /* Resume */
    POMO.running = true;
    POMO.lastTick = Date.now();
    addEv('Pomodoro resumed', 'g');
  }
  pomoRenderUI();
}

function pomoSkip() {
  if (POMO.state === 'idle') return;
  pomoPhaseComplete();
}

function pomoReset() {
  POMO.state = 'idle';
  POMO.running = false;
  POMO.round = 1;
  POMO.remainMs = POMO.workMin * 60 * 1000;
  POMO.totalMs = POMO.remainMs;
  addEv('Pomodoro reset', 'w');
  pomoRenderUI();
  pomoRenderTime();
  pomoRenderDots();
  document.getElementById('brkBanner').classList.remove('on');
}

function pomoPhaseComplete() {
  const wasWork = POMO.state === 'work';

  if (wasWork) {
    POMO.completed++;
    POMO.totalFocusMs += POMO.workMin * 60 * 1000;

    if (POMO.round >= POMO.rounds) {
      /* Long break after all rounds */
      POMO.state = 'long';
      POMO.remainMs = POMO.longMin * 60 * 1000;
      POMO.totalMs = POMO.remainMs;
      addEv('All ' + POMO.rounds + ' rounds done! Long break: ' + POMO.longMin + 'm', 'g');
      document.getElementById('brkBannerTxt').textContent = 'All rounds complete! Take a ' + POMO.longMin + 'm break.';
    } else {
      /* Short break */
      POMO.state = 'short';
      POMO.remainMs = POMO.shortMin * 60 * 1000;
      POMO.totalMs = POMO.remainMs;
      addEv('Round ' + POMO.round + ' done! Short break: ' + POMO.shortMin + 'm', 'g');
      document.getElementById('brkBannerTxt').textContent = 'Round ' + POMO.round + '/' + POMO.rounds + ' done! Take a ' + POMO.shortMin + 'm break.';
    }
    document.getElementById('brkBanner').classList.add('on');
    playAlert();
    /* Notification */
    if (Notification.permission === 'granted') {
      new Notification('Focus Monitor', { body: wasWork ? 'Time for a break!' : 'Break over — back to work!', silent: true });
    }
  } else {
    /* Break is over, start next work session */
    document.getElementById('brkBanner').classList.remove('on');
    if (POMO.state === 'long') {
      /* Full cycle done — reset */
      POMO.round = 1;
      /* Auto-show session summary after all pomodoro rounds complete */
      setTimeout(() => showSessionSummary(), 500);
    } else {
      POMO.round++;
    }
    POMO.state = 'work';
    POMO.remainMs = POMO.workMin * 60 * 1000;
    POMO.totalMs = POMO.remainMs;
    addEv('Round ' + POMO.round + '/' + POMO.rounds + ' — focus time!', 'g');
    playTone(600, 0.1); setTimeout(() => playTone(800, 0.12), 100);
    if (Notification.permission === 'granted') {
      new Notification('Focus Monitor', { body: 'Break over — round ' + POMO.round + ' starts!', silent: true });
    }
  }

  POMO.lastTick = Date.now();
  POMO.running = POMO.autoStart;
  pomoRenderUI();
  pomoRenderDots();
}

function pomoTick() {
  if (!POMO.running || POMO.state === 'idle') return;
  const now = Date.now();
  const dt = now - POMO.lastTick;
  POMO.lastTick = now;
  POMO.remainMs -= dt;

  if (POMO.remainMs <= 0) {
    POMO.remainMs = 0;
    pomoPhaseComplete();
    return;
  }
  pomoRenderTime();
}

function pomoRenderTime() {
  const totalSec = Math.ceil(POMO.remainMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  document.getElementById('pomoTime').textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

  /* Arc */
  const circumference = 2 * Math.PI * 54;
  const progress = POMO.totalMs > 0 ? POMO.remainMs / POMO.totalMs : 0;
  const offset = circumference * (1 - progress);
  const arc = document.getElementById('pomoArc');
  arc.setAttribute('stroke-dashoffset', offset);

  /* Colors per phase */
  const colors = { idle: 'var(--muted)', work: 'var(--red-d)', short: 'var(--green)', long: 'var(--blue)' };
  const phaseNames = { idle: 'Ready', work: 'Focus', short: 'Short Break', long: 'Long Break' };
  const col = colors[POMO.state] || 'var(--muted)';
  arc.setAttribute('stroke', col);
  document.getElementById('pomoTime').style.color = col;
  document.getElementById('pomoPhase').textContent = phaseNames[POMO.state] || 'Ready';
  document.getElementById('pomoPhase').style.color = col;

  /* Section border accent */
  const pomoEl = document.getElementById('pomoSec');
  pomoEl.className = 'pomo-sec ' + POMO.state;

  /* Stats */
  document.getElementById('pomoCompleted').textContent = POMO.completed;
  document.getElementById('pomoTotalFocus').textContent = Math.round(POMO.totalFocusMs / 60000) + 'm';
  document.getElementById('pomoCycle').textContent = POMO.round + ' / ' + POMO.rounds;
}

function pomoRenderUI() {
  const startBtn = document.getElementById('pomoStartBtn');
  const skipBtn = document.getElementById('pomoSkipBtn');
  const resetBtn = document.getElementById('pomoResetBtn');

  if (POMO.state === 'idle') {
    startBtn.textContent = 'Start';
    startBtn.className = 'pomo-btn primary';
    skipBtn.style.display = 'none';
    resetBtn.style.display = 'none';
  } else if (POMO.running) {
    startBtn.textContent = 'Pause';
    startBtn.className = 'pomo-btn';
    skipBtn.style.display = '';
    resetBtn.style.display = '';
  } else {
    startBtn.textContent = 'Resume';
    startBtn.className = 'pomo-btn primary';
    skipBtn.style.display = '';
    resetBtn.style.display = '';
  }
  pomoRenderTime();
}

function pomoRenderDots() {
  const container = document.getElementById('pomoRounds');
  let html = '';
  for (let i = 1; i <= POMO.rounds; i++) {
    let cls = 'pomo-dot';
    if (POMO.state === 'work' && i === POMO.round) cls += ' active';
    else if (i < POMO.round) cls += ' done';
    else if (i === POMO.round && (POMO.state === 'short' || POMO.state === 'long')) cls += ' done';
    html += `<div class="${cls}"></div>`;
  }
  container.innerHTML = html;
}

/* Request notification permission */
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

/* ══════════════════════════════════════════
   TIMELINE
   ══════════════════════════════════════════ */
function updateTL() {
  const now = Date.now();
  if (now - S.curMinStart > 60000) {
    const mh = S.focusHist.filter(h => h.t >= S.curMinStart && h.t < S.curMinStart + 60000);
    const r  = mh.length > 0 ? mh.filter(h => h.f).length / mh.length : (S.status === 'away' ? 0 : 0.5);
    S.tlData.push({ r, st: S.status });
    if (S.tlData.length > 29) S.tlData.shift();
    S.curMinStart = now;
  }
  const cur = S.focusHist.filter(h => h.t >= S.curMinStart);
  const cr  = cur.length > 0 ? cur.filter(h => h.f).length / cur.length : null;

  function barColor(r, st) {
    if (st === 'away') return '#E24B4A';
    return r > 0.65 ? '#97C459' : r > 0.35 ? '#EF9F27' : '#E24B4A';
  }
  const bars = S.tlData.map(b => {
    if (!b) return `<div class="tl-bar" style="height:8%;background:var(--border)"></div>`;
    return `<div class="tl-bar" style="height:${Math.max(8, b.r * 100)}%;background:${barColor(b.r, b.st)};opacity:0.6" title="${Math.round(b.r * 100)}% focused"></div>`;
  });
  if (cr !== null) {
    bars.push(`<div class="tl-bar" style="height:${Math.max(8, cr * 100)}%;background:${barColor(cr, S.status)};border:1.5px solid var(--amber);" title="now: ${Math.round(cr * 100)}%"></div>`);
  }
  document.getElementById('tlBars').innerHTML = bars.join('');
}

/* ══════════════════════════════════════════
   WEEKLY HEATMAP
   ══════════════════════════════════════════ */
function updateHeatmap() {
  const store = loadStore();
  const grid = document.getElementById('heatmap');
  const labels = document.getElementById('hmLabels');
  let html = '';
  let lblHtml = '';
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const now = new Date();

  for (let d = 6; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const key = date.toISOString().slice(0, 10);
    const day = store.days?.[key];

    if (d === 0) {
      lblHtml += `<span style="color:var(--amber)">${dayNames[date.getDay()]}</span>`;
    } else {
      lblHtml += `<span>${dayNames[date.getDay()]}</span>`;
    }

    /* 4 blocks per day: morning (6-10), midday (10-14), afternoon (14-18), evening (18-22) */
    const periods = [[6,10],[10,14],[14,18],[18,22]];
    periods.forEach(([start, end]) => {
      let focusMin = 0;
      if (day?.hourly) {
        for (let h = start; h < end; h++) {
          if (day.hourly[h]) focusMin += day.hourly[h] / 60000;
        }
      }
      /* Also add live data for today from per-hour tracking */
      if (d === 0 && key === todayKey()) {
        for (let h = start; h < end; h++) {
          if (S.hourFocusMs[h]) focusMin += S.hourFocusMs[h] / 60000;
        }
      }
      const intensity = Math.min(focusMin / 60, 1); /* 60 min = full */
      let color;
      if (intensity === 0) color = 'var(--border)';
      else if (intensity < 0.25) color = '#1a3a1a';
      else if (intensity < 0.5) color = '#2a5a2a';
      else if (intensity < 0.75) color = '#3a7a2a';
      else color = '#4a9a3a';
      html += `<div class="hm-cell" style="background:${color}" title="${dayNames[date.getDay()]} ${start}:00-${end}:00: ${Math.round(focusMin)}m"></div>`;
    });
  }
  grid.innerHTML = html;
  labels.innerHTML = lblHtml;
}

/* ══════════════════════════════════════════
   TAB VISIBILITY
   ══════════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  const now = Date.now();
  const dt = now - S.tabLastChange;
  if (S.tabVisible) S.tabVisibleMs += dt;
  else S.tabHiddenMs += dt;
  S.tabVisible = !document.hidden;
  if (!S.tabVisible) {
    S.tabSwitches++;
    addEv('Tab switched away', 'w');
  } else {
    addEv('Tab returned', 'i');
  }
  S.tabLastChange = now;
});

/* ══════════════════════════════════════════
   DAILY GOAL
   ══════════════════════════════════════════ */
function setGoal(val) {
  S.goalMin = Math.max(10, Math.min(600, parseInt(val) || 120));
  document.getElementById('goalInput').value = S.goalMin;
  showToast('Goal set to ' + S.goalMin + ' min', 'success');
}

function updateGoal() {
  const { store, today } = getTodayData();
  const totalFocusMin = (S.focusMs + (today.focusMs || 0)) / 60000;
  const pct = Math.min(Math.round(totalFocusMin / S.goalMin * 100), 100);
  const circumference = 2 * Math.PI * 26; /* r=26 */
  const offset = circumference * (1 - pct / 100);
  document.getElementById('goalArc').setAttribute('stroke-dashoffset', offset);
  document.getElementById('goalPct').textContent = pct + '%';
  const goalCol = pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--muted)';
  document.getElementById('goalPct').style.color = goalCol;
  document.getElementById('goalArc').setAttribute('stroke', goalCol);
  document.getElementById('goalProgress').textContent = `${Math.round(totalFocusMin)}m / ${S.goalMin}m focused`;
  document.getElementById('goalToday').textContent = `Today's sessions: ${(today.sessions || 0)}`;
}

/* ══════════════════════════════════════════
   SESSION SUMMARY
   ══════════════════════════════════════════ */
function showSessionSummary() {
  const now = Date.now();
  const sessionMs = now - S.sessionStart;
  const activeMs = S.focusMs + S.distMs;
  const focusPct = activeMs > 0 ? Math.round(S.focusMs / activeMs * 100) : 0;

  /* Count distractions from events */
  const distractionCount = S.events.filter(e => e.msg && (e.msg.toLowerCase().includes('distracted') || e.msg.toLowerCase().includes('looking away'))).length + S.tabSwitches;

  /* Posture score — read from current UI display */
  const postureEl = document.getElementById('postureScore');
  const postureText = postureEl ? postureEl.textContent.trim() : '--';

  /* Populate */
  document.getElementById('sumDuration').textContent = fmtMs(sessionMs);
  document.getElementById('sumFocus').textContent = fmtMs(S.focusMs);
  document.getElementById('sumFocusPct').textContent = focusPct + '%';
  document.getElementById('sumFocusPct').style.color = focusPct > 60 ? 'var(--green)' : focusPct > 40 ? 'var(--amber)' : 'var(--red-d)';
  document.getElementById('sumDistractions').textContent = distractionCount;
  document.getElementById('sumBestStreak').textContent = fmtMsShort(S.bestStreakMs);
  document.getElementById('sumBlinks').textContent = S.blinks;
  document.getElementById('sumPosture').textContent = postureText;
  document.getElementById('sumPomo').textContent = POMO.completed;

  /* Motivational line */
  let motivation;
  if (focusPct > 80) motivation = 'Outstanding focus!';
  else if (focusPct > 60) motivation = 'Solid work session!';
  else if (focusPct > 40) motivation = 'Room to improve';
  else motivation = 'Tough session \u2014 tomorrow will be better';
  document.getElementById('sumMotivation').textContent = motivation;

  document.getElementById('summaryModal').classList.add('on');
}

function hideSessionSummary() {
  document.getElementById('summaryModal').classList.remove('on');
}

/* ══════════════════════════════════════════
   EXPORT
   ══════════════════════════════════════════ */
function exportData() {
  const data = {
    exported: new Date().toISOString(),
    session: {
      start: new Date(S.sessionStart).toISOString(),
      focusMs: S.focusMs,
      distractedMs: S.distMs,
      awayMs: S.awayMs,
      blinks: S.blinks,
      bestStreakMs: S.bestStreakMs,
      calibrated: S.calibrated,
    },
    events: S.events,
    timeline: S.tlData.filter(Boolean),
    history: loadStore(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `focus-monitor-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Session exported!', 'success');
  addEv('Session data exported', 'i');
}

/* ══════════════════════════════════════════
   PAUSE SCREEN — quotes, proverbs, jokes
   ══════════════════════════════════════════ */
const PAUSE_QUOTES = [
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Focus is not about saying yes. It's about saying no.", author: "Steve Jobs" },
  { text: "Your mind is a garden, your thoughts are the seeds. You can grow flowers or you can grow weeds.", author: "William Wordsworth" },
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
  { text: "A year from now you'll wish you had started today.", author: "Karen Lamb" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
  { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
  { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
  { text: "Fall seven times, stand up eight.", author: "Japanese Proverb" },
  { text: "A smooth sea never made a skilled sailor.", author: "Franklin D. Roosevelt" },
  { text: "The harder you work, the luckier you get.", author: "Gary Player" },
  { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
  { text: "Why do programmers prefer dark mode? Because light attracts bugs.", author: "Dev Joke" },
  { text: "There are only 10 types of people in the world: those who understand binary and those who don't.", author: "Programmer Humor" },
  { text: "A SQL query walks into a bar, sees two tables, and asks... 'Can I join you?'", author: "Database Joke" },
  { text: "To iterate is human, to recurse divine.", author: "L. Peter Deutsch" },
  { text: "First, solve the problem. Then, write the code.", author: "John Johnson" },
  { text: "Simplicity is the soul of efficiency.", author: "Austin Freeman" },
  { text: "Vision without execution is just hallucination.", author: "Henry Ford" },
  { text: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius" },
  { text: "We are what we repeatedly do. Excellence is not an act, but a habit.", author: "Aristotle" },
  { text: "He who has a why to live can bear almost any how.", author: "Friedrich Nietzsche" },
  { text: "The mind is everything. What you think, you become.", author: "Buddha" },
  { text: "When you feel like stopping, think about why you started.", author: "Unknown" },
  { text: "Take a deep breath. You're doing better than you think.", author: "Break Reminder" },
  { text: "Stretch your neck, roll your shoulders, unclench your jaw. You're welcome.", author: "Your Body" },
  { text: "99 little bugs in the code, 99 little bugs. Take one down, patch it around... 127 little bugs in the code.", author: "Every Developer Ever" },
  { text: "I don't always test my code, but when I do, I do it in production.", author: "The Most Interesting Dev" },
  { text: "Weeks of coding can save you hours of planning.", author: "Dev Wisdom" },
  { text: "The river that flows softly will carve the deepest valley.", author: "African Proverb" },
  { text: "What we see depends mainly on what we look for.", author: "John Lubbock" },
  { text: "If you can dream it, you can do it.", author: "Walt Disney" },
  { text: "Absorb what is useful, discard what is useless, add what is uniquely your own.", author: "Bruce Lee" },
  { text: "Between stimulus and response there is a space. In that space is our power to choose.", author: "Viktor Frankl" },
  { text: "Rest is not idleness. To lie on the grass on a summer's day, listening... is hardly a waste of time.", author: "John Lubbock" },
];

let lastQuoteIdx = -1;

function showPauseScreen() {
  const overlay = document.getElementById('pauseOverlay');
  const quoteEl = document.getElementById('pauseQuote');
  const authorEl = document.getElementById('pauseAuthor');

  /* Pick a random quote, avoid repeating the last one */
  let idx;
  do { idx = Math.floor(Math.random() * PAUSE_QUOTES.length); } while (idx === lastQuoteIdx && PAUSE_QUOTES.length > 1);
  lastQuoteIdx = idx;
  const q = PAUSE_QUOTES[idx];

  quoteEl.textContent = '"' + q.text + '"';
  quoteEl.classList.remove('show');
  authorEl.textContent = '— ' + q.author;
  authorEl.classList.remove('show');

  overlay.classList.add('on');

  /* Animate in after a beat */
  requestAnimationFrame(() => {
    setTimeout(() => { quoteEl.classList.add('show'); authorEl.classList.add('show'); }, 50);
  });
}

function hidePauseScreen() {
  document.getElementById('pauseOverlay').classList.remove('on');
}

/* ══════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.key.toLowerCase()) {
    case 'c': startCalibration(); break;
    case 'm': toggleSound(); break;
    case 'e': exportData(); break;
    case ' ':
      e.preventDefault();
      S.paused = !S.paused;
      if (S.paused) {
        setStatus('paused');
        addEv('Tracking paused', 'i');
        showPauseScreen();
      } else {
        S.lastChange = Date.now();
        S.lastStateSwitch = 0;
        setStatus('active');
        addEv('Tracking resumed', 'g');
        hidePauseScreen();
      }
      break;
    case '1': toggleAmbient('rain'); break;
    case '2': toggleAmbient('forest'); break;
    case '3': toggleAmbient('lofi'); break;
    case '0': stopAmbient(); showToast('Ambient off', 'info'); break;
    case 's': cycleSensitivity(); break;
    case 'p': pomoToggle(); break;
    case 'n': pomoSkip(); break;
    case 'q': showSessionSummary(); break;
  }
});

/* ══════════════════════════════════════════
   SMART NOTIFICATIONS
   ══════════════════════════════════════════ */
function checkSmartNotifs(now, focusPct, recentPct) {
  /* Throttle: at most one notification every 60 seconds */
  if (now - S.lastSmartNotif < 60000) return;

  const sessionMin = (now - S.sessionStart) / 60000;
  const focusMin = S.focusMs / 60000;

  /* Milestone: first 10 minutes of focus */
  if (focusMin >= 10 && !S.smartNotifShown['focus10']) {
    smartNotify('10 minutes of focus locked in!', 'success');
    S.smartNotifShown['focus10'] = true; return;
  }

  /* Milestone: 30 min focus */
  if (focusMin >= 30 && !S.smartNotifShown['focus30']) {
    smartNotify('30 minutes focused — you\'re in the zone!', 'success');
    S.smartNotifShown['focus30'] = true; return;
  }

  /* Milestone: 60 min focus */
  if (focusMin >= 60 && !S.smartNotifShown['focus60']) {
    smartNotify('1 hour of deep focus — outstanding!', 'success');
    S.smartNotifShown['focus60'] = true; return;
  }

  /* Milestone: 2 hours focus */
  if (focusMin >= 120 && !S.smartNotifShown['focus120']) {
    smartNotify('2 hours focused — you\'re a machine!', 'success');
    S.smartNotifShown['focus120'] = true; return;
  }

  /* Focus score above 90% after 5+ min */
  if (sessionMin > 5 && focusPct >= 90 && !S.smartNotifShown['pct90']) {
    smartNotify('90%+ focus score — incredible discipline!', 'success');
    S.smartNotifShown['pct90'] = true; return;
  }

  /* Focus dropping: recent 5-min score dropped 30%+ from session average */
  if (sessionMin > 10 && S.lastFocusPct5min > 0 && recentPct < S.lastFocusPct5min - 30 && !S.smartNotifShown['drop_' + Math.floor(now / 300000)]) {
    smartNotify('Focus dropped ' + (S.lastFocusPct5min - recentPct) + '% in the last 5 min — need a break?', 'info');
    S.smartNotifShown['drop_' + Math.floor(now / 300000)] = true; return;
  }

  /* Best streak beaten */
  if (S.curStreakMs > 0 && S.curStreakMs > S.bestStreakMs && S.curStreakMs === S.bestStreakMs && !S.smartNotifShown['newbest_' + Math.floor(S.bestStreakMs / 60000)]) {
    smartNotify('New best streak — keep it going!', 'success');
    S.smartNotifShown['newbest_' + Math.floor(S.bestStreakMs / 60000)] = true; return;
  }

  /* Long streak congratulations every 15 min */
  const streakMin = Math.floor(S.curStreakMs / 60000);
  if (streakMin >= 15 && streakMin % 15 === 0 && !S.smartNotifShown['streak' + streakMin]) {
    smartNotify(streakMin + ' min unbroken focus streak!', 'success');
    S.smartNotifShown['streak' + streakMin] = true; return;
  }

  /* Store recent focus % for drop detection */
  S.lastFocusPct5min = recentPct;
}

function smartNotify(msg, type) {
  S.lastSmartNotif = Date.now();
  showToast(msg, type);
  addEv(msg, type === 'success' ? 'g' : 'i');
  /* Browser notification too */
  if (Notification.permission === 'granted') {
    new Notification('Focus Monitor', { body: msg, silent: true });
  }
}

/* ══════════════════════════════════════════
   POMODORO AUTO-PAUSE WHEN AWAY
   ══════════════════════════════════════════ */
const POMO_AWAY_PAUSE_MS = 120000; /* 2 minutes away → auto-pause pomo */

function checkPomoAutoPause(now) {
  if (POMO.state === 'idle' || !POMO.running) return;

  if (S.status === 'away') {
    const awayDur = now - S.lastFace;
    if (awayDur > POMO_AWAY_PAUSE_MS && !S.pomoAutoPaused) {
      /* Auto-pause the Pomodoro */
      POMO.running = false;
      S.pomoAutoPaused = true;
      pomoRenderUI();
      addEv('Pomodoro auto-paused — away for 2+ min', 'w');
      showToast('Pomodoro paused — you\'ve been away', 'info');
    }
  } else if (S.pomoAutoPaused && S.status === 'active') {
    /* Auto-resume when user returns */
    POMO.running = true;
    POMO.lastTick = now;
    S.pomoAutoPaused = false;
    pomoRenderUI();
    addEv('Pomodoro auto-resumed — welcome back!', 'g');
    showToast('Pomodoro resumed — welcome back!', 'success');
    playFocusIn();
  }
}

/* ══════════════════════════════════════════
   MAIN UI TICK
   ══════════════════════════════════════════ */
function tick() {
  const now = Date.now();
  const sess = now - S.sessionStart;
  document.getElementById('mSession').textContent = fmtMs(sess);
  document.getElementById('mFocus').textContent   = fmtMs(S.focusMs);
  document.getElementById('mAway').textContent    = fmtMs(S.awayMs);

  const active = sess - S.awayMs;
  const fp = active > 0 ? Math.round(S.focusMs / active * 100) : 0;
  const fpCol = fp >= 70 ? 'var(--green)' : fp >= 40 ? 'var(--amber)' : 'var(--red-d)';
  document.getElementById('fScore').textContent = fp + '%';
  document.getElementById('fScore').style.color = fpCol;
  document.getElementById('fFill').style.width = fp + '%';
  document.getElementById('fFill').style.background = fpCol;

  const recent = S.focusHist.filter(h => now - h.t < 300000);
  const rp = recent.length > 0 ? Math.round(recent.filter(h => h.f).length / recent.length * 100) : 0;
  const rpCol = rp >= 70 ? 'var(--green)' : rp >= 40 ? 'var(--amber)' : 'var(--red-d)';
  document.getElementById('rScore').textContent = rp + '%';
  document.getElementById('rScore').style.color = rpCol;
  document.getElementById('rFill').style.width = rp + '%';
  document.getElementById('rFill').style.background = rpCol;

  document.getElementById('clk').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });

  /* Tab visibility update */
  const tdt = now - S.tabLastChange;
  if (S.tabVisible) {
    document.getElementById('tabVisible').textContent = fmtMs(S.tabVisibleMs + tdt);
    document.getElementById('tabHidden').textContent = fmtMs(S.tabHiddenMs);
  } else {
    document.getElementById('tabVisible').textContent = fmtMs(S.tabVisibleMs);
    document.getElementById('tabHidden').textContent = fmtMs(S.tabHiddenMs + tdt);
  }
  document.getElementById('tabSwitches').textContent = S.tabSwitches;

  /* Smart notifications */
  checkSmartNotifs(now, fp, rp);

  /* Pomodoro */
  pomoTick();
  checkPomoAutoPause(now);

  updateTL();
  updateGoal();

  /* Distracted tick sound + popup */
  const popup = document.getElementById('distractedPopup');
  if (S.status === 'distracted' && S.distractedSince > 0) {
    const distDur = now - S.distractedSince;
    document.getElementById('dpTime').textContent = fmtMs(distDur);
    popup.classList.add('show');
    /* Tick every 2 seconds — subtle reminder */
    if (now - S.lastTickSound >= 2000) {
      playTick();
      S.lastTickSound = now;
    }
  } else {
    popup.classList.remove('show');
  }
}

/* ══════════════════════════════════════════
   CAMERA & MEDIAPIPE
   ══════════════════════════════════════════ */
async function initCam() {
  document.getElementById('noCam').style.display = 'none';
  document.getElementById('errMsg').textContent = '';
  try {
    const video  = document.getElementById('vid');
    const canvas = document.getElementById('cnv');
    const ctx    = canvas.getContext('2d');

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }, audio: false
    });
    video.srcObject = stream;
    await video.play();
    S.camOn = true;

    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;

    let mpReady = false;
    function drawRaw() {
      if (!mpReady) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      requestAnimationFrame(drawRaw);
    }
    requestAnimationFrame(drawRaw);

    setStatus('active');
    addEv('Camera started — all processing on-device', 'g');

    let fm;
    try {
      if (typeof FaceMesh === 'undefined') throw new Error('MediaPipe CDN not loaded');
      fm = new FaceMesh({ locateFile: f => 'lib/mediapipe/' + f });
      fm.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      fm.onResults(results => {
        mpReady = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (results.multiFaceLandmarks?.length > 0) {
          const lm = results.multiFaceLandmarks[0];
          drawOverlay(ctx, lm, canvas.width, canvas.height);
          onFace(lm);
        } else { onMissing(); }
      });

      await fm.initialize();
      addEv('Face detection model loaded', 'g');
    } catch (mpErr) {
      console.warn('MediaPipe init failed:', mpErr);
      addEv('Face model failed — camera-only mode', 'w');
      return;
    }

    let lastSend = 0;
    const TARGET_FPS = 15;
    async function loop(ts) {
      if (ts - lastSend >= 1000 / TARGET_FPS) {
        lastSend = ts;
        try { await fm.send({ image: video }); } catch(e) { /* skip */ }
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

  } catch (err) {
    console.error(err);
    setStatus('err');
    document.getElementById('noCam').style.display = 'flex';
    document.getElementById('errMsg').textContent = err.name === 'NotAllowedError'
      ? 'Permission denied — allow camera in browser settings.'
      : 'Could not access camera: ' + err.message;
    addEv('Camera error: ' + err.name, 'b');
  }
}

/* ══════════════════════════════════════════
   SAVE ON CLOSE
   ══════════════════════════════════════════ */
window.addEventListener('beforeunload', () => { persistSession(); });

/* ══════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════ */
window.addEventListener('load', () => {
  updateHeatmap();
  pomoRenderUI();
  pomoRenderDots();
  pomoRenderTime();
  setTimeout(() => { initCam(); }, 500);
});

setInterval(tick, 1000);
setInterval(updateHeatmap, 60000);
tick();

/* ══════════════════════════════════════════
   EVENT LISTENER BINDINGS (Chrome Extension CSP)
   ══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  /* Header buttons */
  document.getElementById('ambRain').addEventListener('click', () => toggleAmbient('rain'));
  document.getElementById('ambForest').addEventListener('click', () => toggleAmbient('forest'));
  document.getElementById('ambLofi').addEventListener('click', () => toggleAmbient('lofi'));
  document.getElementById('ambVol').addEventListener('input', function() { setAmbientVol(this.value); });
  document.getElementById('sensBtn').addEventListener('click', cycleSensitivity);
  document.getElementById('calibBtn').addEventListener('click', startCalibration);
  document.getElementById('soundBtn').addEventListener('click', toggleSound);
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('summaryBtn').addEventListener('click', showSessionSummary);

  /* Camera */
  document.getElementById('camBtn').addEventListener('click', initCam);

  /* Banners */
  document.getElementById('brkDismissBtn').addEventListener('click', dismissBreak);
  document.getElementById('drowsyDismissBtn').addEventListener('click', dismissDrowsy);
  document.getElementById('postureDismissBtn').addEventListener('click', dismissPosture);

  /* Pomodoro */
  document.getElementById('pomoStartBtn').addEventListener('click', pomoToggle);
  document.getElementById('pomoSkipBtn').addEventListener('click', pomoSkip);
  document.getElementById('pomoResetBtn').addEventListener('click', pomoReset);
  document.getElementById('pomoWorkInput').addEventListener('change', pomoUpdateSettings);
  document.getElementById('pomoShortInput').addEventListener('change', pomoUpdateSettings);
  document.getElementById('pomoLongInput').addEventListener('change', pomoUpdateSettings);
  document.getElementById('pomoRoundsInput').addEventListener('change', pomoUpdateSettings);

  /* Goal */
  document.getElementById('goalInput').addEventListener('change', function() { setGoal(this.value); });

  /* Summary modal */
  document.getElementById('summaryCloseBtn').addEventListener('click', hideSessionSummary);
  document.getElementById('summaryExportBtn').addEventListener('click', () => { exportData(); hideSessionSummary(); });
});
