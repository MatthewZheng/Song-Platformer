# Games (`src/games/<game>/`)

Contains the four song-reactive Three.js games (`runner`, `horror`, `tiles`, `rail`).
Each game exports `GameModule` (`index.ts`), `generateLevel` + `defaultParams` + `paramRanges` (`level.ts`), deterministic headless simulation `simulate` (`sim.ts`), and automated playtest `bot.ts`.
No game may import from another game.
