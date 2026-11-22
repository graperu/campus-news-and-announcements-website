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
const coverage = new Set();
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
        surface: this.dataset.motion || null,
        element: this,
        frames: args[0],
        options: args[1],
      });
      return original.apply(this, args);
    };
  });
  const collect = async () => {
    for (const name of await page.evaluate(() =>
      motionStarts.map((item) => item.surface).filter(Boolean),
    ))
      coverage.add(name);
  };
  const authAvailable =
    (await (await page.request.get(base + '/api/config')).json()).authAvailable !== false;
  let releaseLoading;
  const loadingGate = new Promise((resolve) => {
    releaseLoading = resolve;
  });
  let holdLoading = true;
  await page.route('**/api/public/articles**', async (route) => {
    if (holdLoading) await loadingGate;
    await route.continue();
  });
  await page.goto(base);
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'loading')))
    .toBe(true);
  holdLoading = false;
  releaseLoading();
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
  const firstCardStarts = await card.evaluate(
    (el) => motionStarts.filter((a) => a.element === el).length,
  );
  await page.evaluate(async () => {
    const motion = await import('/js/motion.js');
    motion.refreshMotion();
    motion.refreshMotion();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  assert.equal(
    await card.evaluate((el) => motionStarts.filter((a) => a.element === el).length),
    firstCardStarts,
    'Already visible cards must not replay on refresh',
  );
  // A new DOM result must be registered automatically, without an app-specific hook.
  await card.evaluate((el) => {
    const clone = el.cloneNode(true);
    clone.id = 'motion-dynamic-check';
    clone.removeAttribute('data-motion');
    el.before(clone);
  });
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.target === 'motion-dynamic-check')))
    .toBe(true);
  await page.locator('#motion-dynamic-check').evaluate((el) => el.remove());
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'footer')))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'community')))
    .toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }));
  await expect(page.locator('#back-to-top')).toBeVisible();
  await page.locator('#back-to-top').click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(2);
  await expect(page.locator('.brand')).toBeFocused();
  await expect(page.locator('#back-to-top')).toBeHidden();

  await collect();
  if (authAvailable) await page.locator('#account').click();
  else {
    await page.goto(base + '/?view=workspace');
    await page.locator('#dialog[open]').waitFor();
  }
  await expect(page.locator('#dialog')).toBeVisible();
  if (authAvailable) {
    await expect(page.locator('#email')).toBeFocused();
    await page.locator('#form-error').evaluate((el) => {
      el.textContent = 'Kiểm tra hiển thị trạng thái nhập liệu';
    });
    await expect
      .poll(() => page.evaluate(() => motionStarts.some((a) => a.target === 'form-error')))
      .toBe(true);
    await settle(page);
    const entered = await page.evaluate(
      () => motionStarts.filter((a) => a.target === 'dialog').length,
    );
    await page.locator('#email').fill('motion-check@test.invalid');
    assert.equal(
      await page.evaluate(() => motionStarts.filter((a) => a.target === 'dialog').length),
      entered,
      'Typing must not replay dialog motion',
    );
  }
  assert.ok(await page.evaluate(() => motionStarts.some((a) => a.target === 'dialog')));
  // Reopening/replacing a dialog must win over an earlier asynchronous close.
  await page.evaluate(async () => {
    const motion = await import('/js/motion.js'),
      dialog = document.querySelector('#dialog');
    const pending = motion.dismissDialog(dialog);
    motion.presentDialog(dialog);
    await pending;
  });
  await expect(page.locator('#dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).not.toBeVisible();
  assert.ok(
    await page.evaluate(() =>
      motionStarts.some((a) => a.target === 'dialog' && a.options.duration === 140),
    ),
  );
  if (authAvailable) await expect(page.locator('#account')).toBeFocused();
  else {
    await page.locator('.brand').click();
    await wait(page);
  }
  const category = page.locator('[data-category="notices"]'),
    categoryNode = await category.elementHandle();
  await category.hover();
  await expect(category).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await category.click();
  await wait(page);
  await expect(category).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  assert.equal(
    await categoryNode.evaluate((el) => el === document.querySelector('[data-category="notices"]')),
    true,
    'Navigation must preserve the active button for underline/focus continuity',
  );
  await expect(category).toBeFocused();
  await expect
    .poll(() =>
      category.evaluate((el) => new DOMMatrix(getComputedStyle(el, '::after').transform).m11),
    )
    .toBe(1);
  await page.locator('.brand').click();
  await wait(page);
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
  await page.locator('#site-search').fill('__uth_motion_no_match__');
  await page.locator('#site-search').press('Enter');
  await page.locator('.empty').waitFor();
  await expect
    .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'empty')))
    .toBe(true);
  await page.locator('.brand').click();
  await wait(page);

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
  await collect();

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
  if (authAvailable) {
    await page.locator('#account').click();
    await expect(page.locator('#email')).toBeFocused();
  }
  assert.equal(await page.evaluate(() => motionStarts.length), 0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#content')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'storage/reports/ui-motion/home-1440.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.reload();
  await wait(page);
  await page.screenshot({ path: 'storage/reports/ui-motion/home-375.png', fullPage: true });
  if (authAvailable) {
    await page.locator('#account').click();
    await page.screenshot({ path: 'storage/reports/ui-motion/login-375.png' });
    await page.keyboard.press('Escape');
  }
  findings.push({ motion: 'reduced', effects: 0, visibleContent: true, instantScroll: true });

  if (process.env.ADMIN_LOGIN_FILE && authAvailable) {
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
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.editorial-item').first().scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'editorial')))
      .toBe(true);
    await collect();
    await page.screenshot({ path: 'storage/reports/ui-motion/workspace-1440.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.reload();
    await wait(page);
    const overview = page.locator('.workspace-overview'),
      summary = overview.locator('summary').first();
    await summary.click();
    await expect
      .poll(() => page.evaluate(() => motionStarts.some((a) => a.target === 'details-body')))
      .toBe(true);
    await settle(page);
    await expect(overview).toHaveAttribute('open', '');
    await expect
      .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'stat')))
      .toBe(true);
    await summary.evaluate((el) => {
      for (let i = 0; i < 7; i++) el.click();
    });
    await settle(page);
    await expect(overview).not.toHaveAttribute('open', '');
    await expect(overview.locator('.details-body')).toHaveCSS('overflow', 'visible');
    await summary.click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(overview).toHaveAttribute('open', '');
    await expect(overview.locator('.details-body')).toHaveCSS('overflow', 'visible');
    await summary.click();
    await expect(overview).not.toHaveAttribute('open', '');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const filter = page.locator('.filter-panel');
    await filter.locator('summary').click();
    await settle(page);
    await page.locator('#editorial-query').focus();
    const filterStarts = await filter.evaluate(
      (el) => motionStarts.filter((a) => a.element === el).length,
    );
    await page.locator('#editorial-query').fill('UTH');
    await expect(page.locator('#editorial-query')).toBeFocused();
    assert.equal(
      await filter.evaluate((el) => motionStarts.filter((a) => a.element === el).length),
      filterStarts,
      'Filtering must not move the active form',
    );
    await page.locator('[data-tab="history"]').click();
    await page.locator('.history-table tbody tr').first().scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.evaluate(() => motionStarts.some((a) => a.surface === 'history')))
      .toBe(true);
    await collect();
    await page.locator('[data-tab="manage"]').click();
    await page.locator('#add-category').click();
    await expect(page.locator('#dialog input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#dialog')).not.toBeVisible();
    await page.locator('[data-tab="articles"]').click();
    await wait(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
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
  const expected = [
    'chrome',
    'intro',
    'feature',
    'section',
    'card',
    'sidebar',
    'community',
    'article',
    'results',
    'empty',
    'loading',
    'footer',
  ];
  if (process.env.ADMIN_LOGIN_FILE && authAvailable)
    expected.push('workspace', 'stat', 'editorial', 'history');
  for (const name of expected)
    assert.ok(coverage.has(name), `Missing actual motion coverage: ${name}`);
  findings.push({ coverage: [...coverage].sort(), expected: expected.length });
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
