import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export async function runFullRunTest(songId = 'ctd', baseUrl = 'http://localhost:3000') {
  console.log(`[fullrun] Launching Playwright full-run verification for song=${songId}...`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    // Start in Runner with bot=1 & overlay=1
    const url = `${baseUrl}/?song=${encodeURIComponent(songId)}&cut=demo&game=runner&t=0&bot=1&seed=777&overlay=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await page.waitForFunction(
      () => {
        const pt = (window as unknown as { __playtest?: { ready?: boolean } }).__playtest;
        return Boolean(pt && pt.ready);
      },
      { timeout: 15_000 },
    );

    const gamesVisited: string[] = [];
    const recordActiveGame = async () => {
      const g = await page.evaluate(() => {
        const pt = (window as unknown as { __playtest?: { activeGame?: string } }).__playtest;
        return pt?.activeGame ?? '';
      });
      if (g && !gamesVisited.includes(g)) {
        gamesVisited.push(g);
      }
      return g;
    };

    // 1. Verify RUNNER
    const g1 = await recordActiveGame();
    console.log(`[fullrun] Game 1 active: ${g1}`);
    await page.waitForTimeout(1800);

    // Trigger death -> hyperspace -> HORROR
    await page.evaluate(() => {
      const pt = (window as unknown as { __playtest?: { forceDeath?: () => void } }).__playtest;
      pt?.forceDeath?.();
    });
    await page.waitForFunction(
      () => {
        const pt = (window as unknown as {
          __playtest?: { activeGame?: string; phase?: string };
        }).__playtest;
        return pt?.activeGame === 'horror' && pt?.phase === 'active';
      },
      { timeout: 10_000 },
    );

    // 2. Verify HORROR
    const g2 = await recordActiveGame();
    console.log(`[fullrun] Game 2 active: ${g2}`);
    await page.waitForTimeout(1800);

    // Trigger death -> hyperspace -> TILES
    await page.evaluate(() => {
      const pt = (window as unknown as { __playtest?: { forceDeath?: () => void } }).__playtest;
      pt?.forceDeath?.();
    });
    await page.waitForFunction(
      () => {
        const pt = (window as unknown as {
          __playtest?: { activeGame?: string; phase?: string };
        }).__playtest;
        return pt?.activeGame === 'tiles' && pt?.phase === 'active';
      },
      { timeout: 10_000 },
    );

    // 3. Verify TILES
    const g3 = await recordActiveGame();
    console.log(`[fullrun] Game 3 active: ${g3}`);
    await page.waitForTimeout(1800);

    // Trigger death -> hyperspace -> loops back to RUNNER (verifying 3-game loop without rail)
    await page.evaluate(() => {
      const pt = (window as unknown as { __playtest?: { forceDeath?: () => void } }).__playtest;
      pt?.forceDeath?.();
    });
    await page.waitForFunction(
      () => {
        const pt = (window as unknown as {
          __playtest?: { activeGame?: string; phase?: string };
        }).__playtest;
        return pt?.activeGame === 'runner' && pt?.phase === 'active';
      },
      { timeout: 10_000 },
    );
    console.log(`[fullrun] Verified loop back to RUNNER after TILES death.`);

    // Finish song run -> verify Results screen & Argon Playtest Report
    await page.evaluate(() => {
      const pt = (window as unknown as { __playtest?: { finishRun?: () => void } }).__playtest;
      pt?.finishRun?.();
    });

    await page.waitForSelector('[data-testid="results-screen"]', {
      state: 'visible',
      timeout: 10_000,
    });
    await page.waitForSelector('[data-testid="argon-report-banner"]', {
      state: 'visible',
      timeout: 10_000,
    });

    const summary = await page.evaluate(() => {
      const banner =
        document.querySelector('[data-testid="argon-report-banner"]')?.textContent?.trim() ?? '';
      const totalScore =
        document.querySelector('[data-testid="results-total-score"]')?.textContent?.trim() ?? '0';
      const reportCards = document.querySelectorAll('[data-testid^="report-card-"]').length;
      const verifiedIssues = document.querySelectorAll('[data-testid^="report-verified-issue-"]').length;
      return {
        banner,
        totalScore,
        reportCards,
        verifiedIssues,
      };
    });

    console.log(`[fullrun] Results screen rendered!`);
    console.log(`[fullrun]   Total Score: ${summary.totalScore}`);
    console.log(`[fullrun]   Banner: "${summary.banner}"`);
    console.log(`[fullrun]   Game Report Cards: ${summary.reportCards} | [✓] Verified Issues: ${summary.verifiedIssues}`);

    if (consoleErrors.length > 0) {
      throw new Error(`Uncaught page errors during fullrun: ${consoleErrors.join('; ')}`);
    }
    if (summary.reportCards < 3) {
      throw new Error(`Expected 3 game report cards on results screen, got ${summary.reportCards}`);
    }

    await context.close();
    console.log(`[fullrun] PASS ✓ All 3 core games (runner -> horror -> tiles -> runner) and Results Report verified with 0 errors.`);
  } finally {
    await browser.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const songId = process.argv[2] || 'ctd';
  runFullRunTest(songId).catch((err) => {
    console.error('[fullrun] FAILED:', err);
    process.exit(1);
  });
}
