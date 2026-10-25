# Build, Analysis & Playtest Scripts

Node 20+ TypeScript scripts executed with `tsx`:
- `hello.ts`: Verifies `gemini-4-argon` on the Interactions API (`thinking_level: "low"`).
- `analyze.ts`: Orchestrates DSP (`analysis/analyze.py`), `ffmpeg` audio slicing, and semantic annotation.
- `semantic.ts`: Calls `gemini-4-argon` to label song sections, moods, palettes, and rail districts snapped to beat grids.
- `gen-monster.ts`: Generates and processes original monster sprites via `gemini-nano-banana-2.1` and `sharp`.
- `playtest.ts`: Runs headless Chromium via Playwright, records bot gameplay + metrics, and muxes audio via `ffmpeg`.
- `critique.ts`: Feeds playtest metrics and video/frames into `gemini-4-argon` to critique and patch level parameters and code slots in a verification loop.
