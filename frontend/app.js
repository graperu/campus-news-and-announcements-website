import { readRouteState, publicUrl, workspaceUrl, DraftSession } from './ui-state.js';
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
const state = {
  user: null,
  config: null,
  categories: [],
  articles: [],
  versions: [],
  category: '',
  query: '',
  page: 1,
  tab: 'articles',
  editorialQuery: '',
  editorialStatus: '',
  editorialCategory: '',
  editorialPage: 1,
  editorialSort: 'updated-desc',
  historyQuery: '',
  historyPage: 1,
};
const date = (value) =>
  new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
const labels = {
  draft: 'Bản nháp',
  submitted: 'Chờ duyệt',
  approved: 'Đã duyệt',
  published: 'Đã xuất bản',
  rejected: 'Cần chỉnh sửa',
};
let viewGeneration = 0,
  viewController;
async function api(path, options = {}) {
  if (!options.method || options.method === 'GET') options.signal ??= viewController?.signal;
  const headers = { 'X-Campus-Client': '1', ...options.headers };
  const token = sessionStorage.getItem('uth_access_token');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { ...options, headers });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Máy chủ chưa phản hồi. Vui lòng thử lại.');
  }
  if (!response.ok) throw new Error(data.error || `Yêu cầu thất bại (${response.status})`);
  return data;
}
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}
let draftSession = null,
  draftDirty = false,
  dialogReturnFocus = null,
  archiveObjectUrl = null;
function modal(html) {
  draftSession = null;
  draftDirty = false;
  dialogReturnFocus = document.activeElement;
  $('#dialog-body').innerHTML = html;
  const heading = $('#dialog-body h2');
  if (heading) {
    heading.id = 'dialog-title';
    heading.tabIndex = -1;
    $('#dialog').setAttribute('aria-labelledby', 'dialog-title');
  }
  if (!$('#dialog').open) $('#dialog').showModal();
  (
    $('#dialog-body input:not([type=file]), #dialog-body textarea, #dialog-body select') || heading
  )?.focus({ preventScroll: true });
}
function confirmDraftLeave() {
  return (
    !draftDirty ||
    confirm(
      'Bạn có thay đổi chưa lưu lên máy chủ. Rời form? Bản lưu tạm được giữ trong tab này để bạn tiếp tục.',
    )
  );
}
function closeDialog() {
  if ($('#dialog form[aria-busy="true"]')) return;
  if (confirmDraftLeave()) $('#dialog').close();
}
$('.dialog-close').onclick = closeDialog;
$('#dialog').addEventListener('click', (e) => {
  if (e.target === $('#dialog')) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      closeDialog();
  }
});
$('#dialog').addEventListener('close', () => {
  draftDirty = false;
  draftSession = null;
  if (archiveObjectUrl) {
    URL.revokeObjectURL(archiveObjectUrl);
    archiveObjectUrl = null;
  }
  const target = dialogReturnFocus?.isConnected
    ? dialogReturnFocus
    : $('#new-article') || $('#account');
  target?.focus({ preventScroll: true });
});
window.addEventListener('beforeunload', (event) => {
  if (draftDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function setFormStatus(message) {
  const status = $('#form-progress');
  if (status) status.textContent = message;
}
async function busyButton(button, message, operation) {
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = message;
  try {
    return await operation();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = label;
  }
}
function bindForm(handler) {
  const form = $('#dialog form');
  if (!$('#form-progress'))
    form
      .querySelector('#form-error')
      .insertAdjacentHTML(
        'beforebegin',
        '<p id="form-progress" class="form-progress" role="status" aria-live="polite"></p>',
      );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('[type=submit]');
    if (button.disabled) return;
    const data = Object.fromEntries(new FormData(form));
    const controls = [...form.elements],
      previous = controls.map((x) => x.disabled);
    const close = $('.dialog-close');
    $('#form-error').textContent = '';
    form.setAttribute('aria-busy', 'true');
    close.disabled = true;
    const message = button.textContent.includes('Đăng nhập')
      ? 'Đang đăng nhập…'
      : button.textContent.includes('bản nháp')
        ? 'Đang lưu bản nháp…'
        : 'Đang lưu…';
    await busyButton(button, message, async () => {
      controls.filter((x) => x !== button).forEach((x) => (x.disabled = true));
      setFormStatus(message);
      try {
        await handler(data, form);
      } catch (error) {
        $('#form-error').textContent = error.message;
      } finally {
        controls
          .filter((x) => x !== button)
          .forEach((x) => (x.disabled = previous[controls.indexOf(x)]));
        form.removeAttribute('aria-busy');
        close.disabled = false;
        setFormStatus('');
      }
    });
  };
}
$('#dialog').addEventListener('cancel', (e) => {
  if ($('#dialog form[aria-busy="true"]') || !confirmDraftLeave()) e.preventDefault();
});

function errorBox() {
  return '<p id="form-error" class="error" role="alert"></p>';
}
function picture(a, cls = 'card-image') {
  return a.image
    ? `<img class="${cls}" src="${esc(a.image)}" alt="" loading="lazy">`
    : '<div class="text-visual" aria-hidden="true">UTH</div>';
}
function tag(a) {
  return `<span class="tag">${esc(a.category_name)}</span>`;
}
function meta(a) {
  return `<div class="meta"><span>${esc(a.author_name)}</span><span aria-hidden="true">·</span><time datetime="${esc(a.published_at)}">${date(a.published_at)}</time></div>`;
}
function href(a) {
  return `/article/${encodeURIComponent(a.slug)}`;
}
function card(a) {
  return `<article class="card"><a data-route href="${href(a)}">${picture(a)}${tag(a)}<h3>${esc(a.title)}</h3></a>${a.source_url ? '' : `<p>${esc(a.summary)}</p>`}${meta(a)}</article>`;
}
function syncNavigation() {
  const nav = $('#category-nav'),
    children = [...nav.children].filter((el) => el.getBoundingClientRect().width > 0);
  const gap = Number.parseFloat(getComputedStyle(nav).columnGap) || 0;
  const contentWidth =
    children.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) +
    Math.max(0, children.length - 1) * gap;
  const more = contentWidth > nav.clientWidth + 2;
  nav.classList.toggle('is-scrollable', more);
  $('#nav-next').hidden = !more || nav.scrollLeft >= nav.scrollWidth - nav.clientWidth - 2;
  $('#nav-hint').hidden = !more;
}
const navigationObserver = new ResizeObserver(syncNavigation);
navigationObserver.observe($('#category-nav'));
navigationObserver.observe($('#categories'));
document.fonts.ready.then(syncNavigation);
$('#category-nav').addEventListener('scroll', syncNavigation, { passive: true });
window.addEventListener('resize', syncNavigation);
$('#nav-next').onclick = () =>
  $('#category-nav').scrollBy({
    left: 220,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  });
$('#search').onsubmit = (e) => {
  e.preventDefault();
  state.query = new FormData(e.target).get('q').trim();
  state.category = '';
  state.page = 1;
  navigate(publicUrl(state));
};
function updateHeader() {
  $('#account').disabled = false;
  $('#site-search').disabled = false;
  $('#search button').disabled = false;
  $('#site-search').value = state.query;
  $('#account').textContent = state.user ? `${state.user.name} ↗` : 'Đăng nhập ↗';
  $('#workspace').hidden = !['author', 'editor'].includes(state.user?.role);
  $('#categories').innerHTML = state.categories
    .map(
      (c) =>
        `<button class="nav-link ${state.category === c.id ? 'active' : ''}" data-category="${esc(c.id)}">${esc(c.name)}</button>`,
    )
    .join('');
  document.querySelectorAll('[data-category]').forEach((button) => {
    button.classList.toggle('active', button.dataset.category === state.category);
    button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
    button.onclick = () => {
      state.category = button.dataset.category;
      state.page = 1;
      state.query = '';
      navigate(publicUrl(state));
    };
  });
  requestAnimationFrame(syncNavigation);
}
async function home() {
  const generation = viewGeneration;
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.query) params.set('q', state.query);
  const articles = await api(`/api/public/articles?${params}`);
  state.articles = articles;
  const filtered = state.category || state.query,
    title = state.query
      ? `Kết quả cho “${state.query}”`
      : state.categories.find((c) => c.id === state.category)?.name || 'Nhịp sống UTH.';
  let html = `<section class="intro"><div><span class="eyebrow">THE CAMPUS JOURNAL</span><h1>${esc(title)}</h1><p>Thông tin đáng tin cậy. Những kết nối có ý nghĩa.</p></div><div class="edition">HÔM NAY<strong>${date(new Date())}</strong></div></section>`;
  if (!filtered && articles.length) {
    const a = articles[0],
      b = articles[1];
    html += `<section class="featured-grid" aria-label="Tin nổi bật"><article class="feature"><a data-route class="feature-media" href="${href(a)}" aria-label="Đọc ${esc(a.title)}">${picture(a)}</a><div class="feature-content">${tag(a)}<a data-route href="${href(a)}"><h2>${esc(a.title)}</h2></a><div class="meta"><span>${esc(a.author_name)} · ${date(a.published_at)}</span><a data-route class="arrow-circle" href="${href(a)}" aria-label="Đọc ${esc(a.title)}">↗</a></div></div></article>${b ? `<article class="side-feature"><a data-route class="side-media" href="${href(b)}" aria-label="Đọc ${esc(b.title)}">${picture(b)}</a><div class="side-content"><div>${tag(b)}</div><a data-route href="${href(b)}"><h2>${esc(b.title)}</h2></a>${b.source_url ? '' : `<p>${esc(b.summary)}</p>`}${meta(b)}</div></article>` : ''}</section>`;
  }
  const feed = !filtered ? articles.slice(2) : articles;
  state.page = Math.max(1, Math.min(state.page, Math.ceil(feed.length / 8) || 1));
  history.replaceState(history.state, '', publicUrl(state));
  html += `<section class="section-title" id="news-heading" tabindex="-1"><h2>${filtered ? 'Tin tức' : 'Dòng tin mới nhất'}</h2><span class="result-count">${feed.length} bài viết${filtered ? ' phù hợp' : ''}</span></section>`;
  const offset = (state.page - 1) * 8,
    items = feed.slice(offset, offset + 8),
    notices = articles.filter((a) => a.category_id === 'notices').slice(0, 4);
  html += articles.length
    ? `<div class="news-layout"><div id="news-feed"><div class="card-grid">${items.map(card).join('')}</div>${feed.length > 8 ? `<div class="pagination"><button class="button outline small" id="prev" ${state.page === 1 ? 'disabled' : ''}>← Trước</button><span>Trang ${state.page} / ${Math.ceil(feed.length / 8)}</span><button class="button outline small" id="next" ${offset + 8 >= feed.length ? 'disabled' : ''}>Tiếp →</button></div>` : ''}</div><aside><div class="notice-board"><span class="eyebrow">CẦN BIẾT</span><h3>Bảng thông tin</h3>${(notices.length ? notices : feed.slice(0, 4)).map((a) => `<article class="notice"><time datetime="${esc(a.published_at)}">${date(a.published_at)}</time><a data-route href="${href(a)}"><h4>${esc(a.title)} ↗</h4></a></article>`).join('')}<p class="source-note">Tin dẫn nguồn được đối chiếu với cổng thông tin Công đoàn UTH. Xem bài gốc để đọc nội dung đầy đủ.</p></div></aside></div>`
    : `<div class="empty"><span class="eyebrow">UTH CAMPUS</span><h2>${filtered ? 'Chưa tìm thấy bài phù hợp' : 'Những câu chuyện đang chờ được viết.'}</h2><p>${filtered ? 'Thử từ khóa khác hoặc chọn tất cả tin tức.' : 'Chưa có bài viết được xuất bản. Ban biên tập có thể tạo bài mới hoặc nhập tin có nguồn chính thức.'}</p><button class="button outline" id="empty-action">${filtered ? 'Xem tất cả tin' : 'Vào không gian biên tập'} ↗</button></div>`;
  html += `<section class="community"><div><span class="eyebrow">CÙNG TẠO NÊN ĐIỀU Ý NGHĨA</span><h2>Câu chuyện tiếp theo có thể là của bạn.</h2><p>Chia sẻ hoạt động, góc nhìn và những chuyển động trong cộng đồng UTH.</p></div><button class="button accent" id="contribute">Gửi một câu chuyện ↗</button></section>`;
  if (generation !== viewGeneration) return;
  $('#content').innerHTML = html;
  syncNavigation();
  bindPublicPagination();
  $('#empty-action')?.addEventListener('click', () => {
    if (filtered) {
      state.query = '';
      state.category = '';
      navigate('/');
    } else openWorkspace();
  });
  $('#contribute').onclick = openWorkspace;
}
function syncWorkspaceUrl() {
  if (new URLSearchParams(location.search).get('view') === 'workspace')
    history.replaceState(history.state, '', workspaceUrl(state));
}
function focusResults(selector) {
  const el = $(selector);
  if (el) {
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}
function bindPublicPagination() {
  const move = (next) => {
    history.replaceState({ ...history.state, scrollY }, '', location.href);
    state.page = next;
    history.pushState({ index: ++routeIndex, scrollY: 0 }, '', publicUrl(state));
    const feed = state.category || state.query ? state.articles : state.articles.slice(2),
      pages = Math.max(1, Math.ceil(feed.length / 8));
    state.page = Math.max(1, Math.min(state.page, pages));
    $('#news-feed').innerHTML = `<div class="card-grid">${feed
      .slice((state.page - 1) * 8, state.page * 8)
      .map(card)
      .join(
        '',
      )}</div>${pages > 1 ? `<nav class="pagination" aria-label="Phân trang tin tức"><button id="prev" class="button outline small" ${state.page === 1 ? 'disabled' : ''}>← Trước</button><span>Trang ${state.page} / ${pages}</span><button id="next" class="button outline small" ${state.page === pages ? 'disabled' : ''}>Tiếp →</button></nav>` : ''}`;
    bindPublicPagination();
    focusResults('#news-heading');
    history.replaceState({ ...history.state, scrollY }, '', location.href);
  };
  $('#prev')?.addEventListener('click', () => move(state.page - 1));
  $('#next')?.addEventListener('click', () => move(state.page + 1));
}

async function article(slug) {
  const generation = viewGeneration;
  const a = await api(`/api/public/articles/${encodeURIComponent(slug)}`);
  const same = await api(
    `/api/public/articles?category=${encodeURIComponent(a.category_id)}`,
  ).catch(() => []);
  let related = same.filter((x) => x.id !== a.id).slice(0, 3);
  if (generation !== viewGeneration) return;
  if (related.length < 3) {
    const more = await api('/api/public/articles').catch(() => []);
    related = [
      ...new Map([...related, ...more.filter((x) => x.id !== a.id)].map((x) => [x.id, x])).values(),
    ].slice(0, 3);
  }
  if (generation !== viewGeneration) return;
  document.title = `${a.title} — UTH Campus`;
  const sourced = !!a.source_url;
  $('#content').innerHTML =
    `<div class="breadcrumb"><a data-route href="/">Trang chủ</a> / ${esc(a.category_name)}</div><div class="article-layout"><article class="article">${tag(a)}<h1>${esc(a.title)}</h1>${meta(a)}${sourced ? `<div class="source-link source-top"><div><strong>Nguồn: ${esc(a.author_name)}</strong><p>Tin dẫn nguồn · Đọc nội dung đầy đủ tại website xuất bản.</p></div><a class="button" href="${esc(a.source_url)}" target="_blank" rel="noopener">Đọc bài gốc ↗</a></div>` : ''}${!sourced ? `<p class="summary">${esc(a.summary)}</p>` : ''}${a.image ? `<img class="article-hero" src="${esc(a.image)}" alt="Ảnh bài viết: ${esc(a.title)}">` : ''}${a.author_id?.startsWith('official-source:') ? '' : `<div class="article-body">${esc(a.body)}</div>`}<p class="article-updated">Cập nhật ${date(a.updated_at)}</p></article>${related.length ? `<aside class="related" aria-label="Tin đọc thêm"><div class="section-title"><h2>Đọc thêm cùng UTH</h2><a data-route href="/">Tất cả tin tức ↗</a></div><div class="related-grid">${related.map(card).join('')}</div></aside>` : ''}</div>`;
}

async function login() {
  if (!state.config.localAuth) {
    await cognitoLogin();
    return;
  }
  modal(
    `<span class="eyebrow">KHÔNG GIAN BIÊN TẬP</span><h2>Chào mừng trở lại.</h2><p>Đăng nhập bằng tài khoản được ban biên tập cấp.</p><form><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Mật khẩu</label><div class="password-field"><input id="password" name="password" type="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" required><button id="toggle-password" class="password-toggle" type="button" aria-controls="password" aria-pressed="false" aria-label="Hiện mật khẩu">Hiện</button></div><p id="caps-lock" class="hint" role="status" hidden>Caps Lock đang bật.</p>${errorBox()}<div class="form-actions"><button type="submit" class="button">Đăng nhập ↗</button></div></form>`,
  );
  $('#toggle-password').onclick = () => {
    const input = $('#password'),
      show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggle-password').textContent = show ? 'Ẩn' : 'Hiện';
    $('#toggle-password').setAttribute('aria-pressed', String(show));
    $('#toggle-password').setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  };
  $('#password').addEventListener('keyup', (event) => {
    $('#caps-lock').hidden = !event.getModifierState('CapsLock');
  });
  $('#password').addEventListener('input', () => {
    $('#form-error').textContent = '';
  });
  bindForm(async (data) => {
    state.user = await api('/api/auth/login', { method: 'POST', body: data });
    $('#dialog').close();
    updateHeader();
    openWorkspace();
  });
}
$('#account').onclick = () => {
  if (!state.user) return login().catch((e) => toast(e.message));
  modal(
    `<h2>${esc(state.user.name)}</h2><p>Vai trò: ${esc({ reader: 'Bạn đọc', author: 'Tác giả', editor: 'Biên tập viên' }[state.user.role])}</p><div class="form-actions"><button id="change-password" class="button">Đổi mật khẩu</button><button id="logout" class="button outline">Đăng xuất</button></div>`,
  );
  $('#change-password').onclick = changePassword;
  $('#logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    sessionStorage.removeItem('uth_access_token');
    DraftSession.clearUser(state.user?.id);
    state.user = null;
    $('#dialog').close();
    updateHeader();
    if (!state.config.localAuth) {
      location.assign(
        `${state.config.cognitoDomain}/logout?${new URLSearchParams({ client_id: state.config.clientId, logout_uri: state.config.redirectUri })}`,
      );
      return;
    }
    navigate('/');
  };
};
function openWorkspace() {
  if (!state.user) {
    login().catch((e) => toast(e.message));
    return;
  }
  if (state.user.role === 'reader') {
    toast('Tài khoản bạn đọc chưa có quyền biên tập.');
    return;
  }
  navigate(workspaceUrl(state));
}
$('#workspace').onclick = openWorkspace;
async function workspace() {
  const generation = viewGeneration;
  if (!state.user) {
    $('#content').innerHTML =
      '<div class="empty"><h2>Đăng nhập để biên tập</h2><p>Sử dụng tài khoản được ban biên tập cấp để tiếp tục.</p><button id="workspace-login" class="button">Đăng nhập ↗</button></div>';
    $('#workspace-login').onclick = () => login().catch((e) => toast(e.message));
    return login();
  }
  if (state.user.role === 'reader') {
    navigate('/');
    return;
  }
  const [versions, history] = await Promise.all([api('/api/editorial'), api('/api/history')]);
  if (generation !== viewGeneration) return;
  state.versions = versions;
  const distinct = new Set(versions.map((v) => v.article_id)).size;
  const wide = matchMedia('(min-width:761px)').matches;
  $('#content').innerHTML =
    `<section class="intro"><div><span class="eyebrow">EDITORIAL STUDIO</span><h1>Không gian biên tập.</h1><p>Xin chào ${esc(state.user.name)}. Cùng đưa những câu chuyện đến cộng đồng.</p></div><button id="new-article" class="button">＋ Viết bài mới</button></section><details class="workspace-overview" ${wide ? 'open' : ''}><summary>Tổng quan · ${distinct} bài viết</summary><div class="stat-grid"><div class="stat"><strong>${distinct}</strong><span>Bài viết có quyền xem</span></div><div class="stat"><strong>${versions.filter((v) => v.status === 'submitted').length}</strong><span>Phiên bản chờ duyệt</span></div><div class="stat"><strong>${versions.filter((v) => v.status === 'draft').length}</strong><span>Phiên bản nháp</span></div><div class="stat"><strong>${history.length}</strong><span>Lượt xuất bản</span></div></div></details><div class="workspace-tabs"><button data-tab="articles">Bài viết & duyệt bài</button><button data-tab="history">Lịch sử xuất bản</button>${state.user.role === 'editor' ? '<button data-tab="manage">Quản lý</button><button data-tab="ops">Vận hành</button>' : ''}</div><div id="workspace-body"></div>`;
  const queueStatuses = state.user.role === 'editor' ? ['submitted', 'approved'] : ['rejected'];
  const queued = versions.filter((v) => queueStatuses.includes(v.status));
  if (queued.length) {
    $('.workspace-tabs').insertAdjacentHTML(
      'beforebegin',
      `<div class="review-callout"><div><strong>${queued.length} phiên bản ${state.user.role === 'editor' ? 'cần biên tập xử lý' : 'cần bạn chỉnh sửa'}</strong><p>${state.user.role === 'editor' ? 'Xem bài chờ duyệt và bài đã duyệt để tiếp tục xuất bản.' : 'Mở lại bản thảo theo phản hồi từ ban biên tập.'}</p></div><button id="open-queue" class="button outline">Xem hàng chờ ↗</button></div>`,
    );
    $('#open-queue').onclick = () => {
      state.tab = 'articles';
      state.editorialStatus = '';
      state.editorialQuery = '';
      state.editorialCategory = '';
      state.editorialSort = 'priority';
      state.editorialPage = 1;
      run(workspace);
    };
  }
  $('#new-article').onclick = () => editArticle();
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
    b.onclick = () => {
      state.tab = b.dataset.tab;
      navigate(workspaceUrl(state));
    };
  });
  if (state.tab === 'history') renderHistory(history, versions);
  else if (state.tab === 'manage') {
    $('#workspace-body').innerHTML =
      '<div class="editorial-list"><div class="editorial-item"><div><h3>Danh mục tin tức</h3><p class="hint">Tổ chức nội dung theo từng chủ đề.</p></div><button id="add-category" class="button outline">Thêm danh mục</button></div><div class="editorial-item"><div><h3>Tài khoản cộng tác viên</h3><p class="hint">Cấp đúng vai trò cho người tham gia biên tập.</p></div><button id="add-user" class="button outline">Thêm tài khoản</button></div></div>';
    $('#add-category').onclick = () => {
      modal(
        `<h2>Thêm danh mục</h2><form><label>Tên danh mục<input name="name" maxlength="80" required></label>${errorBox()}<button type="submit" class="button">Lưu danh mục</button></form>`,
      );
      bindForm(async (data) => {
        await api('/api/categories', { method: 'POST', body: data });
        state.categories = await api('/api/categories');
        updateHeader();
        $('#dialog').close();
        toast('Đã thêm danh mục');
      });
    };
    $('#add-user').onclick = () => {
      modal(
        `<h2>Thêm tài khoản</h2><form><label>Họ tên<input name="name" maxlength="100" required></label><label>Email<input name="email" type="email" required></label><label>Vai trò<select name="role"><option value="author">Tác giả</option><option value="editor">Biên tập viên</option><option value="reader">Bạn đọc</option></select></label>${state.config.localAuth ? '<label>Mật khẩu<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label>' : '<p class="hint">Lời mời đăng nhập sẽ được Cognito gửi đến email này.</p>'}${errorBox()}<button type="submit" class="button">Tạo tài khoản</button></form>`,
      );
      bindForm(async (data) => {
        await api('/api/users', { method: 'POST', body: data });
        $('#dialog').close();
        toast('Đã tạo tài khoản');
      });
    };
  } else if (state.tab === 'ops') {
    const m = await api('/api/ops/metrics');
    $('#workspace-body').innerHTML =
      `<div class="editorial-list"><div class="editorial-item"><div><h3>Origin requests: ${m.originRequests}</h3><p>Public reads: ${m.publicReads}</p><p class="hint">Bộ đếm của process hiện tại, từ ${esc(m.startedAt)}. Cache hit, p95 và freshness trên AWS được đo bằng CloudWatch và bài kiểm thử; không hiển thị số liệu giả.</p></div></div><div class="editorial-item"><div><h3>Trạng thái origin: ${m.originAvailable ? 'Đang phục vụ' : 'Đang diễn tập lỗi'}</h3><p class="hint">Diễn tập local chỉ ngắt public API, không phải sự cố toàn bộ ứng dụng.</p></div>${state.config.localAuth ? `<button class="button outline" id="origin-toggle">${m.originAvailable ? 'Tạm ngắt public origin' : 'Khôi phục origin'}</button>` : ''}</div></div>`;
    $('#origin-toggle')?.addEventListener('click', async () => {
      await api('/api/ops/origin', { method: 'POST', body: { available: !m.originAvailable } });
      run(workspace);
    });
  } else {
    $('#workspace-body').innerHTML =
      `<details class="filter-panel" ${wide ? 'open' : ''}><summary>Tìm kiếm &amp; bộ lọc${state.editorialQuery || state.editorialStatus || state.editorialCategory ? ' · Đang áp dụng' : ''}</summary><form id="editorial-filters" class="editorial-filters" role="search"><label for="editorial-query">Tìm bài viết<input id="editorial-query" type="search" placeholder="Tiêu đề hoặc tác giả…" value="${esc(state.editorialQuery)}"></label><label for="editorial-status">Trạng thái<select id="editorial-status"><option value="">Tất cả trạng thái</option>${Object.entries(
        labels,
      )
        .map(
          ([id, name]) =>
            `<option value="${id}" ${state.editorialStatus === id ? 'selected' : ''}>${name}</option>`,
        )
        .join(
          '',
        )}</select></label><label for="editorial-category">Danh mục<select id="editorial-category"><option value="">Tất cả danh mục</option>${state.categories.map((c) => `<option value="${esc(c.id)}" ${state.editorialCategory === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><label for="editorial-sort">Sắp xếp<select id="editorial-sort">${[
        ['updated-desc', 'Cập nhật mới nhất'],
        ['updated-asc', 'Cập nhật cũ nhất'],
        ['priority', 'Ưu tiên cần xử lý'],
        ['title', 'Tiêu đề A–Z'],
      ]
        .map(
          ([value, name]) =>
            `<option value="${value}" ${state.editorialSort === value ? 'selected' : ''}>${name}</option>`,
        )
        .join(
          '',
        )}</select></label><button id="clear-filters" type="button" class="button outline">Xóa bộ lọc</button></form></details><p id="editorial-count" class="result-count" aria-live="polite"></p><div id="editorial-results"></div>`;
    $('#editorial-filters').onsubmit = (e) => e.preventDefault();
    for (const [id, key] of [
      ['editorial-query', 'editorialQuery'],
      ['editorial-status', 'editorialStatus'],
      ['editorial-category', 'editorialCategory'],
      ['editorial-sort', 'editorialSort'],
    ])
      $(`#${id}`).addEventListener(id === 'editorial-query' ? 'input' : 'change', (e) => {
        state[key] = e.target.value;
        state.editorialPage = 1;
        renderEditorialList(versions);
      });
    $('#clear-filters').onclick = () => {
      state.editorialQuery = '';
      state.editorialStatus = '';
      state.editorialCategory = '';
      state.editorialPage = 1;
      state.editorialSort = 'updated-desc';
      $('#editorial-sort').value = state.editorialSort;
      $('#editorial-query').value = '';
      $('#editorial-status').value = '';
      $('#editorial-category').value = '';
      renderEditorialList(versions);
    };
    renderEditorialList(versions);
  }
}
function renderHistory(history, versions) {
  $('#workspace-body').innerHTML =
    `<div class="history-toolbar"><label for="history-query">Tìm trong lịch sử<input id="history-query" type="search" placeholder="Tiêu đề hoặc tác giả…" value="${esc(state.historyQuery)}"></label><p id="history-count" class="result-count" aria-live="polite"></p></div><div id="history-results"></div>`;
  $('#history-query').oninput = (e) => {
    state.historyQuery = e.target.value;
    state.historyPage = 1;
    draw();
  };
  function draw() {
    const query = state.historyQuery.trim().toLocaleLowerCase('vi');
    const rows = history
      .filter((p) => `${p.title} ${p.author_name}`.toLocaleLowerCase('vi').includes(query))
      .sort((a, b) => b.published_at.localeCompare(a.published_at));
    const pages = Math.max(1, Math.ceil(rows.length / 10));
    state.historyPage = Math.max(1, Math.min(state.historyPage, pages));
    const slice = rows.slice((state.historyPage - 1) * 10, state.historyPage * 10);
    syncWorkspaceUrl();
    $('#history-count').textContent = `${rows.length} lượt xuất bản · Mới nhất trước`;
    $('#history-results').innerHTML = rows.length
      ? `<div class="history-table-wrap"><table class="history-table"><caption class="sr-only">Lịch sử xuất bản bài viết</caption><thead><tr><th scope="col">Bài viết</th><th scope="col">Tác giả</th><th scope="col">Xuất bản lúc</th><th scope="col">Phiên bản</th><th scope="col">Thao tác</th></tr></thead><tbody>${slice
          .map((p) => {
            const article = versions.find((v) => v.article_id === p.article_id);
            return `<tr><td data-label="Bài viết"><strong>${esc(p.title)}</strong></td><td data-label="Tác giả">${esc(p.author_name)}</td><td data-label="Xuất bản lúc"><time datetime="${esc(p.published_at)}">${date(p.published_at)} · ${new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(p.published_at))}</time></td><td data-label="Phiên bản"><code title="${esc(p.version_id)}">${esc(p.version_id)}</code></td><td data-label="Thao tác">${article ? `<button class="button outline small" data-history-version="${esc(p.version_id)}">Xem phiên bản</button>` : '—'}</td></tr>`;
          })
          .join(
            '',
          )}</tbody></table></div>${pages > 1 ? `<nav class="pagination" aria-label="Phân trang lịch sử"><button id="history-prev" class="button outline" ${state.historyPage === 1 ? 'disabled' : ''}>← Trước</button><span>Trang ${state.historyPage} / ${pages}</span><button id="history-next" class="button outline" ${state.historyPage === pages ? 'disabled' : ''}>Tiếp →</button></nav>` : ''}`
      : '<div class="empty">Chưa có lịch sử phù hợp.</div>';
    document.querySelectorAll('[data-history-version]').forEach(
      (button) =>
        (button.onclick = async () => {
          try {
            await busyButton(button, 'Đang mở…', async () => {
              const item = await api(
                `/api/history/${encodeURIComponent(button.dataset.historyVersion)}`,
              );
              modal(
                `<span class="status published">Bản đã xuất bản</span><h2>${esc(item.title)}</h2><p>${esc(item.author_name)} · ${date(item.published_at)}</p><p class="summary">${esc(item.summary)}</p>${item.image ? '<img id="archive-image" class="article-hero" alt="Ảnh của phiên bản đã xuất bản">' : ''}<div class="article-body">${esc(item.body)}</div><p class="hint">Phiên bản: ${esc(item.id)}</p>`,
              );
              if (item.image) {
                const headers = {};
                const token = sessionStorage.getItem('uth_access_token');
                if (token) headers.Authorization = `Bearer ${token}`;
                const response = await fetch(item.image, { headers });
                if (response.ok && $('#dialog').open && $('#archive-image')) {
                  archiveObjectUrl = URL.createObjectURL(await response.blob());
                  $('#archive-image').src = archiveObjectUrl;
                }
              }
            });
          } catch (error) {
            toast(error.message);
          }
        }),
    );
    $('#history-prev')?.addEventListener('click', () => {
      state.historyPage--;
      draw();
      focusResults('#history-count');
    });
    $('#history-next')?.addEventListener('click', () => {
      state.historyPage++;
      draw();
      focusResults('#history-count');
    });
  }
  draw();
}

function renderEditorialList(versions) {
  const query = state.editorialQuery.trim().toLocaleLowerCase('vi');
  const filtered = versions.filter(
    (v) =>
      (!state.editorialStatus || v.status === state.editorialStatus) &&
      (!state.editorialCategory || v.category_id === state.editorialCategory) &&
      (!query || `${v.title} ${v.author_name}`.toLocaleLowerCase('vi').includes(query)),
  );
  const priority = (v) =>
    state.user.role === 'editor'
      ? { submitted: 0, approved: 1, rejected: 2, draft: 3, published: 4 }[v.status]
      : { rejected: 0, draft: 1, submitted: 2, approved: 3, published: 4 }[v.status];
  filtered.sort((a, b) =>
    state.editorialSort === 'title'
      ? a.title.localeCompare(b.title, 'vi')
      : state.editorialSort === 'updated-asc'
        ? a.updated_at.localeCompare(b.updated_at)
        : state.editorialSort === 'priority'
          ? priority(a) - priority(b) || b.updated_at.localeCompare(a.updated_at)
          : b.updated_at.localeCompare(a.updated_at),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  state.editorialPage = Math.max(1, Math.min(state.editorialPage, pages));
  const offset = (state.editorialPage - 1) * 8,
    visible = filtered.slice(offset, offset + 8);
  syncWorkspaceUrl();
  $('#editorial-count').textContent =
    `${filtered.length} phiên bản phù hợp · Hiển thị ${filtered.length ? offset + 1 : 0}–${Math.min(offset + 8, filtered.length)}`;
  $('#editorial-results').innerHTML =
    `<div class="editorial-list">${filtered.length ? visible.map((v) => `<article class="editorial-item ${['submitted', 'approved'].includes(v.status) ? 'needs-review' : ''}"><div><span class="status ${v.status}">${labels[v.status]}</span><h3>${esc(v.title)}</h3><div class="meta">${esc(v.author_name)} · ${esc(v.category_name)} · ${date(v.updated_at)}</div></div><div class="actions"><button class="button outline small" data-preview="${esc(v.id)}">Xem</button>${['draft', 'rejected', 'published'].includes(v.status) ? `<button class="button outline small" data-edit="${esc(v.id)}">${v.status === 'published' ? 'Tạo bản sửa' : 'Sửa'}</button>` : ''}${['draft', 'rejected'].includes(v.status) ? `<button class="button small" data-action="submit" data-version="${esc(v.id)}">Gửi duyệt</button>` : ''}${state.user.role === 'editor' && v.status === 'submitted' ? `<button class="button small" data-action="approve" data-version="${esc(v.id)}">Duyệt</button><button class="button outline small" data-action="reject" data-version="${esc(v.id)}">Yêu cầu sửa</button>` : ''}${state.user.role === 'editor' && v.status === 'approved' ? `<button class="button small" data-action="publish" data-version="${esc(v.id)}">Xuất bản</button>` : ''}</div></article>`).join('') : '<div class="empty"><h2>Chưa có bài phù hợp.</h2><p>Thử đổi từ khóa, trạng thái hoặc danh mục.</p></div>'}</div>`;
  document
    .querySelectorAll('[data-edit]')
    .forEach((b) => (b.onclick = () => editArticle(versions.find((v) => v.id === b.dataset.edit))));
  document.querySelectorAll('[data-preview]').forEach(
    (b) =>
      (b.onclick = () => {
        const v = versions.find((v) => v.id === b.dataset.preview);
        modal(
          `<span class="status ${v.status}">${labels[v.status]}</span><h2>${esc(v.title)}</h2><p>${esc(v.summary)}</p><div class="article-body">${esc(v.body)}</div><p class="hint">Phiên bản: ${esc(v.id)} · Cập nhật ${date(v.updated_at)}</p>`,
        );
      }),
  );
  document.querySelectorAll('[data-action]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (b.disabled) return;
        const originalLabel = b.textContent;
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        b.textContent = 'Đang xử lý…';
        try {
          await api(`/api/versions/${b.dataset.version}/${b.dataset.action}`, {
            method: 'POST',
            body: {},
          });
          toast(
            {
              submit: 'Đã gửi bài để duyệt',
              approve: 'Đã duyệt bài',
              reject: 'Đã yêu cầu chỉnh sửa',
              publish: 'Đã xuất bản bài',
            }[b.dataset.action],
          );
          await run(workspace);
        } catch (e) {
          toast(e.message);
        } finally {
          b.disabled = false;
          b.removeAttribute('aria-busy');
          b.textContent = originalLabel;
        }
      }),
  );
  if (pages > 1) {
    $('#editorial-results').insertAdjacentHTML(
      'beforeend',
      `<nav class="pagination" aria-label="Phân trang biên tập"><button id="editorial-prev" class="button outline" ${state.editorialPage === 1 ? 'disabled' : ''}>← Trước</button><span>Trang ${state.editorialPage} / ${pages}</span><button id="editorial-next" class="button outline" ${state.editorialPage === pages ? 'disabled' : ''}>Tiếp →</button></nav>`,
    );
    $('#editorial-prev').onclick = () => {
      state.editorialPage--;
      renderEditorialList(versions);
      focusResults('#editorial-count');
    };
    $('#editorial-next').onclick = () => {
      state.editorialPage++;
      renderEditorialList(versions);
      focusResults('#editorial-count');
    };
  }
}

function editArticle(v) {
  if (!state.categories.length) {
    toast('Biên tập viên cần tạo danh mục trước khi viết bài.');
    return;
  }
  modal(
    `<span class="eyebrow">BẢN THẢO</span><h2>${v ? 'Chỉnh sửa câu chuyện' : 'Một câu chuyện mới.'}</h2><form><label for="title">Tiêu đề</label><input id="title" name="title" value="${esc(v?.title)}" maxlength="180" required><label for="category">Danh mục</label><select id="category" name="category_id" ${v ? 'disabled' : ''}>${state.categories.map((c) => `<option value="${esc(c.id)}" ${v?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><label for="summary">Tóm tắt</label><textarea id="summary" name="summary" maxlength="500" required>${esc(v?.summary)}</textarea><label for="body">Nội dung</label><textarea id="body" name="body" maxlength="50000" required>${esc(v?.body)}</textarea><label for="image">Ảnh bài viết</label><input id="image" type="file" name="file" accept="image/png,image/jpeg,image/webp"><p class="hint">PNG, JPEG hoặc WebP · Tối đa 5 MB</p>${errorBox()}<div class="form-actions"><button type="submit" class="button">Lưu bản nháp ↗</button><span class="hint">${v?.status === 'published' ? 'Bản đang công khai được giữ nguyên cho đến khi bản sửa được duyệt và xuất bản.' : 'Lưu xong, bạn có thể gửi bài để duyệt.'}</span></div></form>`,
  );
  const backup = new DraftSession(state.user.id, v?.id || 'new'),
    saved = backup.load(),
    form = $('#dialog form');
  draftSession = backup;
  const fields = ['title', 'summary', 'body'];
  if (saved) {
    for (const name of fields)
      if (typeof saved.fields[name] === 'string') form.elements[name].value = saved.fields[name];
    if (!v && saved.fields.category_id) form.elements.category_id.value = saved.fields.category_id;
    draftDirty = true;
  }
  form.insertAdjacentHTML(
    'afterbegin',
    `<p id="draft-backup" class="draft-backup" role="status">${saved ? 'Đã khôi phục bản lưu tạm trong tab này.' : 'Thay đổi được lưu tạm trong tab này, chưa gửi lên máy chủ.'}${saved?.fields.fileName ? ' Ảnh đã chọn trước đó cần được chọn lại.' : ''}</p>`,
  );
  const remember = () => {
    draftDirty = true;
    const values = Object.fromEntries(fields.map((name) => [name, form.elements[name].value]));
    values.category_id = v?.category_id || form.elements.category_id.value;
    values.fileName = form.elements.file.files[0]?.name || '';
    $('#draft-backup').textContent = backup.save(values)
      ? 'Đã lưu tạm trong tab này · Chưa lưu lên máy chủ.'
      : 'Không thể lưu tạm trên trình duyệt. Hãy lưu bản nháp trước khi đóng.';
  };
  form.addEventListener('input', remember);
  form.addEventListener('change', remember);
  bindForm(async (data, form) => {
    let image = v?.image || '';
    const file = form.elements.file.files[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) throw new Error('Ảnh tối đa 5 MB');
      setFormStatus('Đang tải ảnh bài viết…');
      image = (await api('/api/uploads', { method: 'POST', body: file })).url;
    }
    setFormStatus('Đang lưu bản nháp…');
    const body = {
      title: data.title,
      summary: data.summary,
      body: data.body,
      category_id: v?.category_id || data.category_id,
      image,
    };
    await api(v ? `/api/versions/${v.id}` : '/api/articles', { method: v ? 'PUT' : 'POST', body });
    backup.clear();
    draftDirty = false;
    $('#dialog').close();
    toast('Đã lưu bản nháp');
    state.tab = 'articles';
    state.editorialQuery = '';
    state.editorialStatus = '';
    state.editorialCategory = '';
    state.editorialPage = 1;
    state.editorialSort = 'updated-desc';
    await run(workspace);
  });
}
async function cognitoLogin() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)),
    encode = (a) =>
      btoa(String.fromCharCode(...a))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
  const verifier = encode(bytes),
    nonce = encode(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('oauth_verifier', verifier);
  sessionStorage.setItem('oauth_state', nonce);
  const challenge = encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: state.config.clientId,
    redirect_uri: state.config.redirectUri,
    scope: 'openid email profile aws.cognito.signin.user.admin',
    state: nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.assign(`${state.config.cognitoDomain}/oauth2/authorize?${p}`);
}
async function finishOAuth() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code')) return;
  if (p.get('state') !== sessionStorage.getItem('oauth_state'))
    throw new Error('Phiên đăng nhập không hợp lệ');
  const r = await fetch(`${state.config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: state.config.clientId,
      redirect_uri: state.config.redirectUri,
      code: p.get('code'),
      code_verifier: sessionStorage.getItem('oauth_verifier'),
    }),
  });
  const token = await r.json();
  if (!r.ok) throw new Error('Không thể hoàn thành đăng nhập');
  sessionStorage.setItem('uth_access_token', token.access_token);
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_verifier');
  history.replaceState({}, '', '/?view=workspace');
}
async function route() {
  Object.assign(state, readRouteState(location.search));
  updateHeader();
  document.title = 'UTH Campus — Tin tức & Kết nối';
  if (location.pathname.startsWith('/article/'))
    await article(decodeURIComponent(location.pathname.slice(9)));
  else if (new URLSearchParams(location.search).get('view') === 'workspace') await workspace();
  else await home();
}
function loadingView() {
  const editorial = new URLSearchParams(location.search).get('view') === 'workspace';
  const label = editorial
    ? 'Đang tải không gian biên tập…'
    : state.query
      ? 'Đang tìm kiếm tin tức…'
      : 'Đang tải nội dung…';
  if (!state.config) {
    $('#account').disabled = true;
    $('#site-search').disabled = true;
    $('#search button').disabled = true;
  }
  $('#view-status').textContent = label;
  $('#content').setAttribute('aria-busy', 'true');
  $('#content').innerHTML =
    `<div class="loading-shell" aria-hidden="true"><p class="loading-caption">${label}</p><div class="skeleton skeleton-heading"></div><div class="skeleton skeleton-line"></div><div class="skeleton-grid">${Array.from({ length: editorial ? 4 : 3 }, () => '<div class="skeleton-card"><div class="skeleton skeleton-picture"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>').join('')}</div></div>`;
}
async function run(fn) {
  const generation = ++viewGeneration;
  viewController?.abort();
  viewController = new AbortController();
  loadingView();
  try {
    await fn();
    return generation === viewGeneration;
  } catch (e) {
    if (generation !== viewGeneration || e.name === 'AbortError') return false;
    $('#content').innerHTML =
      `<div class="empty" role="alert"><h2>Chưa thể tải nội dung.</h2><p>${esc(e.message)}</p><button class="button outline" id="retry">Thử lại</button></div>`;
    $('#retry').onclick = () => run(fn);
    return false;
  } finally {
    if (generation === viewGeneration) {
      $('#content').removeAttribute('aria-busy');
      $('#view-status').textContent = '';
    }
  }
}

let routeIndex = history.state?.index || 0,
  restoringHistory = false;
history.replaceState({ ...history.state, index: routeIndex }, '', location.href);
async function navigate(path) {
  if ($('#dialog').open) {
    if (!confirmDraftLeave()) return;
    $('#dialog').close();
  }
  history.replaceState({ ...history.state, scrollY }, '', location.href);
  history.pushState({ index: ++routeIndex, scrollY: 0 }, '', path);
  await run(route);
  window.scrollTo({ top: 0, behavior: 'instant' });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-route],a.brand');
  if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', async () => {
  if (restoringHistory) {
    restoringHistory = false;
    return;
  }
  const nextIndex = history.state?.index || 0;
  if ($('#dialog').open && !confirmDraftLeave()) {
    restoringHistory = true;
    history.go(routeIndex - nextIndex);
    return;
  }
  if ($('#dialog').open) $('#dialog').close();
  routeIndex = nextIndex;
  const y = history.state?.scrollY || 0;
  await run(route);
  window.scrollTo({ top: y, behavior: 'instant' });
});

run(async () => {
  state.config = await api('/api/config');
  await finishOAuth();
  const [categories, auth] = await Promise.all([api('/api/categories'), api('/api/auth/me')]);
  state.categories = categories;
  state.user = auth.user;
  await route();
});

function changePassword() {
  modal(
    `<h2>Đổi mật khẩu</h2><form><label>Mật khẩu hiện tại<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>Mật khẩu mới<input name="newPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><p class="hint">Tối thiểu 12 ký tự. Với AWS, cần chữ hoa, chữ thường, số và ký hiệu.</p>${errorBox()}<button type="submit" class="button">Lưu mật khẩu</button></form>`,
  );
  bindForm(async (data) => {
    await api('/api/auth/password', { method: 'POST', body: data });
    sessionStorage.removeItem('uth_access_token');
    DraftSession.clearUser(state.user?.id);
    state.user = null;
    $('#dialog').close();
    updateHeader();
    navigate('/');
    toast('Đã đổi mật khẩu. Vui lòng đăng nhập lại.');
  });
}
