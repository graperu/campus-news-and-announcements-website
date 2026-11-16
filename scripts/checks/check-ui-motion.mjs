import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: true,
});
await mkdir('storage/reports/ui-motion', { recursive: true });
const wait = async (page) => {
  await page.locator('#content[aria-busy]').waitFor({ state: 'detached' });
  await page.locator('.intro,.article').first().waitFor();
};
const settle = (page) =>
  page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
const findings = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'no-preference',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    window.motionStarts = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      window.motionStarts.push({
        target: this.id || this.className,
        frames: args[0],
        options: args[1],
      });
      return original.apply(this, args);
    };
  });
  await page.goto(base);
  await wait(page);
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.target === 'feature')))
    .toBe(true);
  await settle(page);
  await expect(page.locator('#back-to-top')).toBeHidden();
  await expect(page.locator('#reading-progress')).toBeHidden();
  const card = page.locator('.news-layout .card').first();
  await card.scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.target === 'card')))
    .toBe(true);
  await settle(page);
  await card.hover();
  await expect
    .poll(() => card.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42))
    .toBeLessThan(-2);
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await expect(page.locator('#back-to-top')).toBeVisible();
  await page.locator('#back-to-top').click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(2);
  await expect(page.locator('.brand')).toBeFocused();
  await expect(page.locator('#back-to-top')).toBeHidden();

  await page.locator('#account').click();
  await expect(page.locator('#dialog')).toBeVisible();
  await expect(page.locator('#email')).toBeFocused();
  assert.ok(await page.evaluate(() => motionStarts.some((a) => a.target === 'dialog')));
  await page.keyboard.press('Escape');
  await expect(page.locator('#account')).toBeFocused();
  await page.locator('.feature-media').click();
  await wait(page);
  await expect(page.locator('#reading-progress')).toBeVisible();
  const progress = () =>
    page
      .locator('#reading-progress span')
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m11);
  const before = await progress();
  await page.locator('.article-updated').scrollIntoViewIfNeeded();
  await expect.poll(progress).toBeGreaterThan(before + 0.1);
  assert.ok((await progress()) <= 1);
  await page.screenshot({ path: 'storage/reports/ui-motion/article-progress.png' });
  await page.locator('.brand').click();
  await wait(page);
  await expect(page.locator('#reading-progress')).toBeHidden();

  // Exercise the notification lifecycle without changing any server data.
  await page.evaluate(async () => {
    const motion = await import('/js/motion.js'),
      toast = document.querySelector('#toast');
    toast.textContent = 'Kiểm tra hiển thị thông báo';
    toast.classList.add('visible');
    motion.presentToast(toast);
    motion.dismissToast(toast);
    motion.presentToast(toast);
  });
  await settle(page);
  await expect(page.locator('#toast')).toHaveClass('visible');
  await page.evaluate(async () =>
    (await import('/js/motion.js')).dismissToast(document.querySelector('#toast')),
  );
  await expect(page.locator('#toast')).not.toHaveClass('visible');
  await page.evaluate(async () => {
    const toast = document.querySelector('#toast');
    toast.classList.add('visible');
    (await import('/js/motion.js')).dismissToast(toast);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#toast')).not.toHaveClass('visible');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  findings.push({
    motion: 'enabled',
    reveal: true,
    hover: true,
    dialog: true,
    notificationRace: true,
    scrollControls: true,
  });

  // Changing the OS preference must cancel in-flight effects immediately.
  await page.locator('#next').click();
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
  await page.reload();
  await wait(page);
  await page.locator('.news-layout .card').first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await expect(page.locator('#back-to-top')).toBeVisible();
  await page.locator('#back-to-top').click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.locator('#account').click();
  await expect(page.locator('#email')).toBeFocused();
  assert.equal(await page.evaluate(() => motionStarts.length), 0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#content')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'storage/reports/ui-motion/home-1440.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.reload();
  await wait(page);
  await page.screenshot({ path: 'storage/reports/ui-motion/home-375.png', fullPage: true });
  await page.locator('#account').click();
  await page.screenshot({ path: 'storage/reports/ui-motion/login-375.png' });
  await page.keyboard.press('Escape');
  findings.push({ motion: 'reduced', effects: 0, visibleContent: true, instantScroll: true });

  if (process.env.ADMIN_LOGIN_FILE) {
    const text = await readFile(process.env.ADMIN_LOGIN_FILE, 'utf8');
    const email = text.match(/Email:\s*(.+)/)[1].trim(),
      password = text.match(/Password:\s*(.+)/)[1].trim();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#account').click();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#dialog [type=submit]').click();
    await page.locator('#editorial-results').waitFor();
    await wait(page);
    await page.screenshot({ path: 'storage/reports/ui-motion/workspace-1440.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.reload();
    await wait(page);
    await page.screenshot({ path: 'storage/reports/ui-motion/workspace-375.png', fullPage: true });
    await page.locator('#new-article').click();
    await page.screenshot({ path: 'storage/reports/ui-motion/editor-375.png' });
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    findings.push({ workspace: 'real account', form: 'opened without modifying data' });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    'storage/reports/ui-motion/results.json',
    JSON.stringify(findings, null, 2) + '\n',
  );
  console.log(JSON.stringify(findings));
  await page.close();
} finally {
  await browser.close();
}
