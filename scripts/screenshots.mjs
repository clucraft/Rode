/*
 * Regenerate the README screenshots from two simulator instances:
 *
 *   A (RODE_SHOT_A, default :18083)  tidal-swing, an imagery source selected
 *   B (RODE_SHOT_B, default :18084)  slow-drag at 40x with auto commands
 *
 * Both need the admin below to exist. Point RODE_SHOT_CHROME at a Chrome or
 * Edge binary. Run: pnpm screenshots
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/screenshots');
mkdirSync(OUT, { recursive: true });
const CREDS = { username: 'skipper', password: 'correct horse battery staple' };
const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const LAPTOP = { width: 1280, height: 1200, deviceScaleFactor: 1.25 };

const browser = await puppeteer.launch({
  executablePath:
    process.env.RODE_SHOT_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

async function session(base, theme = 'day') {
  const page = await browser.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (c) => {
    await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    });
  }, CREDS);
  await page.evaluate((t) => localStorage.setItem('rode:theme-mode', t), theme);
  return page;
}

async function shot(page, url, file, viewport, settle = 2500) {
  await page.setViewport(viewport);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, settle));
  await page.screenshot({ path: path.join(OUT, file) });
  console.log('wrote', file);
}

const A = process.env.RODE_SHOT_A ?? 'http://127.0.0.1:18083';
const B = process.env.RODE_SHOT_B ?? 'http://127.0.0.1:18084';

// ---- instance A: tidal-swing, Esri imagery selected
{
  const page = await session(A, 'day');
  await shot(page, `${A}/`, 'watch-phone.png', PHONE);
  await shot(page, `${A}/traffic`, 'traffic-laptop.png', LAPTOP);
  await shot(page, `${A}/settings/imagery`, 'imagery-settings.png', LAPTOP, 3500);
  await page.close();
  const night = await session(A, 'night');
  await shot(night, `${A}/`, 'watch-night-phone.png', PHONE);
  await night.close();
}

// ---- instance B: slow-drag; wait for WARNING, then ALARM
{
  const page = await session(B, 'day');
  const waitFor = async (name, timeoutMs) => {
    const start = Date.now();
    for (;;) {
      const st = await page.evaluate(async () =>
        fetch('/api/state')
          .then((r) => r.json())
          .then((j) => j.watch.stateName),
      );
      if (st === name) return true;
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  if (await waitFor('ALARM', 120_000)) {
    await shot(page, `${B}/`, 'watch-alarm-laptop.png', LAPTOP, 1500);
  } else console.log('no ALARM seen');
  await page.close();
}

await browser.close();
