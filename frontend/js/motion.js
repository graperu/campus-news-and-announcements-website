// Progressive enhancement: all content stays visible without animations or JS observers.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let seen = new WeakSet();
const active = new Set(),
  local = new WeakMap();
let observer;
// One registry covers static chrome and every dynamically rendered view.
const surfaces = [
  ['chrome', '.utility .container,header .masthead,header .nav-wrap,header .search-bar', 'fade'],
  ['intro', '#content .intro,#content .breadcrumb', 'rise'],
  ['feature', '#content .feature,#content .side-feature', 'rise'],
  ['section', '#content .section-title', 'rise'],
  ['card', '#content .card', 'rise'],
  ['sidebar', '#content .notice-board', 'rise'],
  ['community', '#content .community', 'rise'],
  [
    'article',
    '.article>h1,.article>.tag,.article>.meta,.article>.summary,.article>.article-hero,.article>.article-body,.article>.source-link,.article>.source-document,.article>.article-updated',
    'fade',
  ],
  [
    'workspace',
    '#content .workspace-tabs,#content .workspace-overview>summary,#content .filter-panel,#content .history-toolbar',
    'fade',
  ],
  ['stat', '#content .stat', 'rise'],
  ['editorial', '#content .editorial-item,#content .review-callout', 'rise'],
  ['history', '#content .history-table thead,#content .history-table tbody tr', 'fade'],
  ['results', '#content .pagination,#content .result-count', 'fade'],
  ['empty', '#content .empty', 'rise'],
  ['loading', '#content .loading-caption', 'fade'],
  ['footer', '.footer-grid>div,.footer-bottom', 'rise'],
];
const presets = new WeakMap();
function animate(element, frames, options) {
  if (reduced.matches || !element?.animate || document.hidden) return null;
  const animation = element.animate(frames, options);
  active.add(animation);
  animation.finished.catch(() => {}).finally(() => active.delete(animation));
  return animation;
}
function stopLocal(element) {
  local.get(element)?.cancel();
  local.delete(element);
}
export function presentDialog(element) {
  stopLocal(element);
  delete element.dataset.closing;
  const effect = animate(
    element,
    [
      { opacity: 0.65, transform: 'translateY(8px) scale(.99)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ],
    { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  if (effect) local.set(element, effect);
}
export async function dismissDialog(element) {
  if (!element.open || element.dataset.closing) return;
  stopLocal(element);
  element.dataset.closing = 'true';
  const effect = animate(
    element,
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(6px) scale(.99)' },
    ],
    { duration: 140, easing: 'ease-in' },
  );
  if (effect) {
    local.set(element, effect);
    await effect.finished.catch(() => {});
    // A newly opened/replaced dialog owns its own effect and must stay open.
    if (local.get(element) !== effect) return;
  }
  local.delete(element);
  delete element.dataset.closing;
  if (element.open) element.close();
}
export function presentToast(element) {
  stopLocal(element);
  const effect = animate(
    element,
    [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 200, easing: 'ease-out' },
  );
  if (effect) local.set(element, effect);
}
export function dismissToast(element) {
  stopLocal(element);
  const effect = animate(
    element,
    [
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(5px)' },
    ],
    { duration: 150, easing: 'ease-in' },
  );
  if (!effect) {
    element.classList.remove('visible');
    return;
  }
  local.set(element, effect);
  const finish = () => {
    if (local.get(element) === effect) {
      element.classList.remove('visible');
      local.delete(element);
    }
  };
  effect.finished.then(finish).catch(() => {
    // Changing the OS preference must not leave a dismissing notification stuck open.
    if (reduced.matches) finish();
  });
}
function createObserver() {
  if (!('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver(
    (entries) => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting || !entry.target.isConnected) continue;
        observer.unobserve(entry.target);
        if (seen.has(entry.target)) continue;
        seen.add(entry.target);
        // Do not move or fade a region the user is already interacting with.
        if (entry.target.matches(':focus-within')) continue;
        const delay = Math.min(order++ * 35, 105);
        const rise = presets.get(entry.target) === 'rise';
        animate(
          entry.target,
          [
            { opacity: 0.72, ...(rise ? { transform: 'translateY(8px)' } : {}) },
            { opacity: 1, ...(rise ? { transform: 'translateY(0)' } : {}) },
          ],
          { duration: 340, delay, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
      }
    },
    { threshold: 0 },
  );
}
createObserver();
const progress = document.querySelector('#reading-progress'),
  bar = progress.querySelector('span'),
  topButton = document.querySelector('#back-to-top');
let frame = 0;
function showTopButton(show) {
  if (show) {
    if (!topButton.hidden && !topButton.dataset.leaving) return;
    stopLocal(topButton);
    delete topButton.dataset.leaving;
    topButton.hidden = false;
    const effect = animate(
      topButton,
      [
        { opacity: 0, transform: 'translateY(6px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 170, easing: 'ease-out' },
    );
    if (effect) local.set(topButton, effect);
  } else {
    if (topButton.hidden || topButton.dataset.leaving) return;
    stopLocal(topButton);
    const effect = animate(topButton, [{ opacity: 1 }, { opacity: 0 }], {
      duration: 120,
      easing: 'ease-in',
    });
    if (!effect) {
      topButton.hidden = true;
      return;
    }
    local.set(topButton, effect);
    topButton.dataset.leaving = 'true';
    const finish = () => {
      if (local.get(topButton) === effect) {
        topButton.hidden = true;
        local.delete(topButton);
        delete topButton.dataset.leaving;
      }
    };
    effect.finished.then(finish).catch(finish);
  }
}
function updateScroll() {
  frame = 0;
  showTopButton(scrollY >= 600);
  const article = document.querySelector('#content:not([aria-busy]) .article');
  progress.hidden = !article;
  if (article) {
    const box = article.getBoundingClientRect(),
      start = scrollY + box.top,
      range = Math.max(1, box.height - innerHeight * 0.55),
      amount = Math.min(1, Math.max(0, (scrollY - start + innerHeight * 0.2) / range));
    bar.style.transform = `scaleX(${amount})`;
  }
}
function scheduleScroll() {
  if (!frame) frame = requestAnimationFrame(updateScroll);
}
window.addEventListener('scroll', scheduleScroll, { passive: true });
window.addEventListener('resize', scheduleScroll);
document.querySelector('#content').addEventListener(
  'load',
  (event) => {
    if (event.target instanceof HTMLImageElement) scheduleScroll();
  },
  true,
);
topButton.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: reduced.matches ? 'instant' : 'smooth' });
  document.querySelector('.brand')?.focus({ preventScroll: true });
});
export function refreshMotion() {
  observer?.disconnect();
  for (const effect of active) if (!effect.effect?.target?.isConnected) effect.cancel();
  bindDisclosures();
  for (const [name, selector, preset] of surfaces)
    document.querySelectorAll(selector).forEach((element) => {
      element.dataset.motion = name;
      presets.set(element, preset);
      if (!reduced.matches && !seen.has(element)) observer?.observe(element);
    });
  scheduleScroll();
}
const boundDetails = new WeakSet();
function bindDisclosures() {
  document.querySelectorAll('#content details').forEach((details) => {
    if (boundDetails.has(details)) return;
    boundDetails.add(details);
    const summary = details.querySelector(':scope>summary');
    if (!summary) return;
    const panel = document.createElement('div');
    panel.className = 'details-body';
    for (const child of [...details.childNodes]) if (child !== summary) panel.append(child);
    details.append(panel);
    const state = { effect: null, target: details.open };
    summary.setAttribute('aria-expanded', String(details.open));
    details.addEventListener('toggle', () => {
      if (!state.effect) summary.setAttribute('aria-expanded', String(details.open));
      scheduleScroll();
    });
    summary.addEventListener('click', (event) => {
      if (reduced.matches || !panel.animate || document.hidden) return;
      event.preventDefault();
      const start = details.open ? panel.getBoundingClientRect().height : 0;
      const target = state.effect ? !state.target : !details.open;
      state.effect?.cancel();
      state.target = target;
      details.open = true;
      panel.style.overflow = 'hidden';
      const end = target ? panel.getBoundingClientRect().height : 0;
      if (!target && panel.contains(document.activeElement)) summary.focus({ preventScroll: true });
      summary.setAttribute('aria-expanded', String(target));
      const effect = animate(
        panel,
        [
          { height: `${start}px`, opacity: target ? 0.65 : 1 },
          { height: `${end}px`, opacity: target ? 1 : 0.65 },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
      state.effect = effect;
      const finish = () => {
        if (state.effect !== effect) return;
        details.open = state.target;
        state.effect = null;
        panel.style.removeProperty('overflow');
        summary.setAttribute('aria-expanded', String(details.open));
        scheduleScroll();
      };
      if (effect) effect.finished.then(finish).catch(finish);
      else finish();
    });
  });
}
let refreshFrame = 0;
function queueRefresh() {
  if (!refreshFrame)
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      refreshMotion();
    });
}
new MutationObserver(queueRefresh).observe(document.querySelector('#content'), {
  childList: true,
  subtree: true,
});
new MutationObserver((records) => {
  const targets = new Set(
    records.map((record) =>
      record.target.nodeType === 1
        ? record.target.closest('.error,.form-progress')
        : record.target.parentElement?.closest('.error,.form-progress'),
    ),
  );
  for (const element of targets)
    if (element?.textContent.trim() && element.isConnected) {
      stopLocal(element);
      const effect = animate(element, [{ opacity: 0.45 }, { opacity: 1 }], {
        duration: 180,
        easing: 'ease-out',
      });
      if (effect) local.set(element, effect);
    }
}).observe(document.querySelector('#dialog-body'), { childList: true, subtree: true });
const dialog = document.querySelector('#dialog');
dialog.addEventListener('close', () => {
  stopLocal(dialog);
  delete dialog.dataset.closing;
});
dialog.addEventListener('keydown', (event) => {
  if (dialog.dataset.closing) event.preventDefault();
});
reduced.addEventListener('change', () => {
  for (const animation of active) animation.cancel();
  observer?.disconnect();
  if (!reduced.matches) {
    seen = new WeakSet();
    refreshMotion();
  }
});
queueRefresh();
