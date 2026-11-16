import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
const findings = [];
await mkdir('output/screenshots', { recursive: true });
try {
  for (const width of [375, 768, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
        reducedMotion: 'reduce',
      }),
      page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(base);
    await page.locator('#search').waitFor();
    await page.locator('img').evaluateAll(async (imgs) => {
      await Promise.all(
        imgs.map(async (img) => {
          img.loading = 'eager';
          try {
            await img.decode();
          } catch {}
        }),
      );
    });
    await page.screenshot({ path: `output/screenshots/home-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw new Error(JSON.stringify({ width, overflow, errors }));
    const link = page.locator('a[data-route]').first();
    if (await link.count()) {
      await link.click();
      await page.locator('.article h1').waitFor();
      await page.locator('img').evaluateAll(async (imgs) => {
        await Promise.all(
          imgs.map(async (img) => {
            img.loading = 'eager';
            try {
              await img.decode();
            } catch {}
          }),
        );
      });
      await page.screenshot({ path: `output/screenshots/article-${width}.png`, fullPage: true });
    }
    findings.push({ width, overflow, errors });
    await context.close();
  }
  await writeFile(
    'output/browser-check.json',
    JSON.stringify({ timestamp: new Date().toISOString(), base, findings }, null, 2),
  );
  console.log(JSON.stringify(findings));
} finally {
  await browser.close();
}
