// Progressive enhancement: all content stays visible without animations or JS observers.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let seen = new WeakSet();
const active = new Set(),
  local = new WeakMap();
let observer;
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
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (seen.has(entry.target)) continue;
        seen.add(entry.target);
        const delay = Math.min(order++ * 35, 105);
        animate(
          entry.target,
          [
            { opacity: 0.7, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 340, delay, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
      }
    },
    { threshold: 0.08 },
  );
}
createObserver();
const progress = document.querySelector('#reading-progress'),
  bar = progress.querySelector('span'),
  topButton = document.querySelector('#back-to-top');
let frame = 0;
function updateScroll() {
  frame = 0;
  topButton.hidden = scrollY < 600;
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
  if (!reduced.matches)
    document
      .querySelectorAll(
        '#content .intro,#content .breadcrumb,#content .feature,#content .side-feature,#content .card,#content .notice-board,#content .community,#content .stat,#content .editorial-item,#content .review-callout,#content .history-table tbody tr',
      )
      .forEach((element) => {
        if (!seen.has(element)) observer?.observe(element);
      });
  scheduleScroll();
}
reduced.addEventListener('change', () => {
  for (const animation of active) animation.cancel();
  observer?.disconnect();
  if (!reduced.matches) {
    seen = new WeakSet();
    refreshMotion();
  }
});
