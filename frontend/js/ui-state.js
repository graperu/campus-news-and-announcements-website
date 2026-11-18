const positive = (value) => Math.max(1, Math.min(10000, Number.parseInt(value, 10) || 1));
export function readRouteState(search) {
  const p = new URLSearchParams(search);
  return {
    category: p.get('category') || '',
    query: p.get('q') || '',
    page: positive(p.get('page')),
    tab: ['articles', 'history', 'manage', 'ops'].includes(p.get('tab'))
      ? p.get('tab')
      : 'articles',
    editorialQuery: p.get('eq') || '',
    editorialStatus: [
      'draft',
      'submitted',
      'approved',
      'scheduled',
      'published',
      'rejected',
    ].includes(p.get('status'))
      ? p.get('status')
      : '',
    editorialCategory: p.get('ec') || '',
    editorialPage: positive(p.get('ep')),
    editorialSort: ['updated-desc', 'updated-asc', 'title', 'priority'].includes(p.get('sort'))
      ? p.get('sort')
      : 'updated-desc',
    historyQuery: p.get('hq') || '',
    historyPage: positive(p.get('hp')),
  };
}
function url(entries) {
  const p = new URLSearchParams(
    entries
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
  return '/' + (p.size ? '?' + p : '');
}
export function publicUrl(state) {
  return url([
    ['category', state.category],
    ['q', state.query],
    ['page', state.page > 1 ? state.page : ''],
  ]);
}
export function workspaceUrl(state) {
  return url([
    ['view', 'workspace'],
    ['tab', state.tab === 'articles' ? '' : state.tab],
    ['eq', state.editorialQuery],
    ['status', state.editorialStatus],
    ['ec', state.editorialCategory],
    ['ep', state.editorialPage > 1 ? state.editorialPage : ''],
    ['sort', state.editorialSort === 'updated-desc' ? '' : state.editorialSort],
    ['hq', state.historyQuery],
    ['hp', state.historyPage > 1 ? state.historyPage : ''],
  ]);
}

// Per-tab, per-account backup. Never stores passwords, tokens or image bytes.
export class DraftSession {
  constructor(userId, versionId = 'new') {
    this.key = `uth:draft:${userId}:${versionId}`;
  }
  load() {
    try {
      const data = JSON.parse(sessionStorage.getItem(this.key));
      if (data && Date.now() - data.savedAt < 86400000) return data;
      sessionStorage.removeItem(this.key);
    } catch {}
    return null;
  }
  save(fields) {
    try {
      sessionStorage.setItem(this.key, JSON.stringify({ fields, savedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }
  clear() {
    try {
      sessionStorage.removeItem(this.key);
    } catch {}
  }
  static clearUser(id) {
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(`uth:draft:${id}:`)) sessionStorage.removeItem(key);
    } catch {}
  }
}
