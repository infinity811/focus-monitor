# Focus Monitor

A browser-based focus tracking tool that uses your webcam and MediaPipe face detection to monitor your attention, posture, and alertness in real-time. **All processing runs locally — nothing leaves your device.**

![Focus Monitor](https://img.shields.io/badge/status-active-green) ![License](https://img.shields.io/badge/license-MIT-blue) ![Single File](https://img.shields.io/badge/size-~110KB-orange)

## Features

### Core Tracking
- **Head Pose Detection** — Tracks yaw (left/right) and pitch (up/down) using 468 facial landmarks
- **Focus Classification** — Detects focused, distracted, and away states with configurable thresholds
- **Calibration** — Set your natural center position for any monitor setup
- **Sensitivity Presets** — Tight, Normal, Wide, Ultra Wide modes for 1-3+ monitor setups

### Body & Alertness
- **Posture Detection** — Monitors slouching by tracking face position relative to calibrated baseline
- **Drowsiness Detection** — Composite score from blink rate, eye aspect ratio (EAR), and long blinks
- **Posture Alerts** — Audio + visual warnings when slouching for 30s+
- **Drowsiness Alerts** — Banner notification when fatigue is detected

### Productivity
- **Pomodoro Timer** — Full cycle: work / short break / long break with configurable durations and rounds
- **Focus Streaks** — Current, best today, and all-time best streak tracking
- **Daily Goal** — Configurable focus time target with progress ring
- **Smart Notifications** — Context-aware messages at focus milestones and drop warnings
- **Session Summary** — Full stats card with motivational message

### Ambient Sounds
- **Rain** — Brown noise with raindrop plinks
- **Forest** — Wind with breathing LFO + two species of bird chirps
- **Lofi** — Chord progression with tape wobble, vinyl crackle, kicks, and hi-hats

All sounds are procedurally generated using the Web Audio API — no external files needed.

### Data & Persistence
- **localStorage Persistence** — Daily focus data, streaks, and goals saved across sessions
- **Weekly Heatmap** — GitHub-style grid showing focus intensity over 7 days
- **Session Timeline** — Minute-by-minute focus history
- **Tab Activity** — Tracks tab switches and hidden/visible time
- **JSON Export** — Download full session data for personal analytics
- **Event Log** — Timestamped log of all state changes and alerts

### UX
- **Pause Mode** — Pause screen with random motivational quotes, proverbs, and dev jokes
- **Distracted Popup** — Live counter showing how long you've been distracted with subtle clock tick
- **Audio Cues** — Tones for focus in/out, posture warnings, and alerts
- **Pomodoro Auto-Pause** — Timer pauses when you leave for 2+ min, resumes when you return
- **Browser Notifications** — Desktop notifications for Pomodoro transitions

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `S` | Cycle sensitivity preset |
| `C` | Calibrate center position |
| `M` | Toggle audio cues |
| `E` | Export session data |
| `Q` | Show session summary |
| `Space` | Pause / resume tracking |
| `P` | Start / pause Pomodoro |
| `N` | Skip Pomodoro phase |
| `1` | Rain ambient |
| `2` | Forest ambient |
| `3` | Lofi ambient |
| `0` | Stop ambient |

## Getting Started

1. Open `index.html` in a browser (Chrome/Edge recommended)
2. Allow camera access when prompted
3. Press `C` to calibrate your natural head position
4. Press `S` to set sensitivity for your monitor setup
5. Press `P` to start a Pomodoro session

No build step, no dependencies, no server — just one HTML file.

## Tech Stack

- **MediaPipe Face Mesh** — 468 facial landmarks via CDN
- **Web Audio API** — All sounds generated procedurally
- **Canvas API** — Camera feed + landmark overlay
- **localStorage** — Session persistence
- **Page Visibility API** — Tab switch detection

## Privacy

Everything runs in your browser. The camera feed is processed locally using MediaPipe's client-side ML model. No data is sent to any server. No cookies, no analytics, no tracking.

## License

MIT
