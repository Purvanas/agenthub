'use strict';

// Navigation URL et positions de lecture. Ce module ne connaît aucun écran : il publie des
// routes, puis app.js ou workspace.js décide quoi afficher.
(function navigationModule(global) {
  const SCROLL_PREFIX = 'ah.scroll.';
  const LAST_ROUTE_KEY = 'ah.lastRoute';
  let lastEmitted = '';

  function clean(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalize(route) {
    const conv = clean(route && route.conv);
    const view = clean(route && route.view);
    const focus = clean(route && route.focus);
    const project = clean(route && route.project);
    const q = clean(route && route.q);
    if (conv) return { conv, focus: focus || null, view: null, project: null, q: null };
    return {
      conv: null,
      focus: null,
      view: view || 'inbox',
      project: project || null,
      q: q || null,
    };
  }

  function current() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hash.get('conv')) {
      return normalize({ conv: hash.get('conv'), focus: hash.get('focus') });
    }
    if (hash.get('view')) {
      return normalize({ view: hash.get('view'), project: hash.get('project'), q: hash.get('q') });
    }

    // Compatibilité des liens demandés avant l'adoption du hash. Le paramètre est seulement
    // lu ici ; le premier replace() le retire pour laisser une URL canonique partageable.
    const query = new URLSearchParams(location.search);
    if (query.get('conv')) return normalize({ conv: query.get('conv'), focus: query.get('focus') });
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY) || 'null');
      if (saved) return normalize(saved);
    } catch {
      /* préférence absente ou illisible */
    }
    return normalize({ view: 'inbox' });
  }

  function signature(route) {
    return route.conv
      ? `conv:${route.conv}:${route.focus || ''}`
      : `view:${route.view}:${route.project || ''}:${route.q || ''}`;
  }

  function rememberRoute(route) {
    try {
      localStorage.setItem(LAST_ROUTE_KEY, JSON.stringify(route));
    } catch {
      /* préférence seulement */
    }
  }

  function emit(route, source) {
    const normalized = normalize(route);
    const sig = signature(normalized);
    // hashchange et popstate peuvent décrire la même traversée. Tant qu'une autre route
    // n'est pas passée entre les deux, le second événement est strictement redondant.
    if (sig === lastEmitted) return;
    lastEmitted = sig;
    rememberRoute(normalized);
    global.dispatchEvent(
      new CustomEvent('agenthub:route', { detail: { ...normalized, source: source || 'url' } })
    );
  }

  function urlFor(route) {
    const normalized = normalize(route);
    const hash = new URLSearchParams();
    if (normalized.conv) {
      hash.set('conv', normalized.conv);
      if (normalized.focus) hash.set('focus', normalized.focus);
    } else {
      hash.set('view', normalized.view);
      if (normalized.project) hash.set('project', normalized.project);
      if (normalized.q) hash.set('q', normalized.q);
    }
    const query = new URLSearchParams(location.search);
    query.delete('conv');
    query.delete('focus');
    const search = query.toString();
    return `${location.pathname}${search ? `?${search}` : ''}#${hash}`;
  }

  function navigate(route, { replace = false, silent = false } = {}) {
    const normalized = normalize(route);
    const url = urlFor(normalized);
    if (replace) history.replaceState(history.state, '', url);
    else if (url !== `${location.pathname}${location.search}${location.hash}`) {
      history.pushState({}, '', url);
    }
    rememberRoute(normalized);
    if (silent) lastEmitted = signature(normalized);
    else emit(normalized, replace ? 'replace' : 'push');
    return normalized;
  }

  function scrollKey(convId) {
    return `${SCROLL_PREFIX}${convId}`;
  }

  function saveScroll(convId, position) {
    if (!convId || !position) return;
    try {
      localStorage.setItem(
        scrollKey(convId),
        JSON.stringify({
          itemId: clean(position.itemId) || null,
          offset: Number(position.offset) || 0,
          atBottom: Boolean(position.atBottom),
          savedAt: Date.now(),
        })
      );
    } catch {
      /* Une position de lecture est un confort : navigation privée peut la refuser. */
    }
  }

  function loadScroll(convId) {
    if (!convId) return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(scrollKey(convId)) || 'null');
      if (!parsed || (!parsed.itemId && !parsed.atBottom)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function clearScroll(convId) {
    try {
      localStorage.removeItem(scrollKey(convId));
    } catch {
      /* rien */
    }
  }

  const fromBrowser = () => emit(current(), 'history');
  global.addEventListener('popstate', fromBrowser);
  global.addEventListener('hashchange', fromBrowser);

  global.AgentHubNavigation = {
    current,
    navigate,
    replace: (route, options) => navigate(route, { ...(options || {}), replace: true }),
    saveScroll,
    loadScroll,
    clearScroll,
  };
})(window);
