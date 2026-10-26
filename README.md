# Argon Arcade

**Song Arcade** turns any song into three synchronized music-driven games (`RUNNER`, `HORROR`, `TILES`) that were designed, playtested, critiqued on video, and verified by **Gemini 4 Argon** (`gemini-4-argon`).

The song plays once from start to end and never pauses. The player starts in **RUNNER**. Each death plays a short death animation, a 1.0s hyperspace jump, and drops the player into the next game while the music keeps going (`RUNNER → HORROR → TILES → RUNNER ...`). When the song ends, the Results screen displays the player's score alongside Argon's full Playtest & Verification Report (including side-by-side Draft vs Final videos, `Baseline → Draft → Final` fast-check scores, bot playtest counts, Argon video review counts, and `[✓]` verified fixes).

---

## Core Games & Musical Layers

1. **RUNNER (`src/games/runner/`) — Listens to: *the beat***
   - Phase 1: 2D desert beat-runner where cacti and swooping birds land on exact beat/onset impacts.
   - Phase 2: 3D isometric lava-crossing grid where comet bursts cross the center lane on downbeats and strong mid/high onsets.
2. **HORROR (`src/games/horror/`) — Listens to: *the structure***
   - First-person 3D office hide-and-seek where section transitions and musical drops trigger the hunt (`LIGHTS OFF`).
   - Proximity audio low-pass filtering, heartbeat pulses, and Director hints follow the song's structural energy.
3. **TILES (`src/games/tiles/`) — Listens to: *the melody***
   - 4-lane (`D F J K`) 3D note highway where lanes follow pitch-class melody contours (`dir: -1 | 0 | 1`) and drop downbeats add two-note chords.
   - Full-screen audio-reactive GLSL fragment shader (`tiles.backgroundShader.glsl`) swells on peaks and dims in valleys.

---

## Autonomous Verification Loop (`Render → Watch → Critique → Patch`)

Built for **Gemini 4 Argon SF Hackathon — Problem Statement Two**:
1. **Step 0 Whole-Song Draft (`gemini-4-argon`, `thinking_level: "high"`)**: Generates initial parameters, level edits, and per-song GLSL shader slots from the DSP song map (`public/songs/<id>/demo.json`).
2. **Step 1 Multi-Entry Fast Check (`scripts/playtest.ts`)**: Runs deterministic 120 Hz headless bot simulations (`simulate()`) from 4 entry points per iteration (`t = 0`, `firstDrop`, and 2 seeded offsets) to evaluate pass criteria (`metrics.json`).
3. **Step 2 Render, Record & Synced Audio Mux (`scripts/playtest.ts`)**: Launches headless Chromium via Playwright with `?bot=1&overlay=1` (corner debug HUD with song time to `0.01s`, beat/downbeat strobe, and hit/miss/life counters) and muxes the exact MP3 slice onto `video.mp4` via `ffmpeg`.
4. **Step 3 Optional Flash Pre-Check (`gemini-3.8-flash`)**: Screens 6 evenly spaced frames for blank/frozen rendering or unreadable HUDs (`--flash-precheck`).
5. **Step 4 Multimodal Video Critique (`scripts/critique.ts`)**: Sends `video.mp4`, `metrics.json`, failing checks, and `paramRanges` to `gemini-4-argon` on the Interactions API, chaining context across iterations via `previous_interaction_id` and verifying `[✓]` resolved issues on video.
6. **Step 5 Patch & Re-Verify**: Clamps patched parameters to `paramRanges`, validates shader compilation, writes `public/reports/<id>/report.json` and `public/reports/live.json`, and saves side-by-side `draft.mp4` and `final.mp4` clips.

---

## Commands

```bash
# Start development server on http://localhost:3000
npm run dev

# Run offline librosa DSP + Gemini 4 Argon semantic song analysis
npm run analyze:all

# Run the closed-loop playtest & Argon critique across all songs and games
npm run critique -- --song all --game all

# Run live single-game loop demo (writes to /reports/live.json for /loop.html)
npm run demo:loop

# Run end-to-end Playwright verification (RUNNER -> HORROR -> TILES -> RUNNER -> Results Report)
npm run fullrun

# Typecheck and build for production
npm run lint
npm run build
```

## Live Demo Views
- **Main Arcade**: `http://localhost:3000/`
- **Interactive Pipeline Architecture**: `http://localhost:3000/architecture.html`
- **Live Verification Loop Monitor**: `http://localhost:3000/loop.html`
