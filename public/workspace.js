'use strict';

(function workspaceModule(global) {
  const VIEWS = new Set(['inbox', 'projects', 'project', 'worktrees', 'search', 'archive']);
  const TITLES = { inbox: 'À traiter', projects: 'Projets', project: 'Projet', worktrees: 'Branches', search: 'Recherche', archive: 'Archives' };
  const STATUS = { working: 'En cours', done: 'À relire', error: 'En erreur', stopped: 'Interrompu', idle: 'Disponible' };
  const REASONS = { ask: 'Décision attendue', error: 'À vérifier', silent: 'Sans nouvelle', done: 'Travail terminé', working: 'En cours' };
  const PROVIDERS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' };
  const body = document.querySelector('#workspace-body');
  const nf = new Intl.NumberFormat('fr-FR');
  let route = { view: 'inbox' };
  let generation = 0;
  let currentScope = null;
  let overview = null;
  let worktreeRows = [];
  let rules = [];
  let searchFilters = {};
  let refreshTimer = null;
  const shownAlerts = new Set();

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (text, max = 180) => String(text || '').length > max ? `${String(text).slice(0, max)}…` : String(text || '');
  const money = (value) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value) || 0);
  const basename = (path) => String(path || '').replace(/\/$/, '').split(/[\\/]/).pop() || 'Sans projet';
  const date = (value) => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
  const duration = (ms) => {
    const minutes = Math.floor((Number(ms) || 0) / 60_000);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  };
  const bridge = () => global.agentHub;
  const state = () => bridge() ? bridge().getState() : { convs: [] };
  const visible = () => !document.querySelector('#workspace-view').classList.contains('hidden');
  const navigate = (next) => global.AgentHubNavigation.navigate(next);
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  async function request(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET', signal: options.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erreur ${response.status}`);
    return data;
  }

  function newScope() {
    if (currentScope) currentScope.abort('actualisation');
    currentScope = global.AgentHubActionContext.capture({ view: route.view });
    return currentScope;
  }

  function intro(title, subtitle, actions = '') {
    return `<div class="ws-intro"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${actions}</div>`;
  }
  function empty(title, text) {
    return `<div class="ws-empty"><strong>${esc(title)}</strong>${esc(text || '')}</div>`;
  }
  function stat(value, label, accent = false) {
    return `<div class="ws-stat${accent ? ' accent' : ''}"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
  }
  function metrics(value = {}) {
    return `<div class="ws-metrics"><span><b>${nf.format(value.tokens || 0)}</b> tokens</span><span><b>${money(value.costUsd)}</b> estimés</span><span><b>${duration(value.durationMs || value.timeMs)}</b> connues</span></div>`;
  }
  function section(title, html, count) {
    return `<section class="ws-section"><h2 class="ws-section-title">${esc(title)}${count == null ? '' : `<span class="ws-count">${esc(count)}</span>`}</h2>${html}</section>`;
  }

  function conversationCard(conv, reason) {
    const project = conv.project || conv.cwd;
    return `<article class="ws-card${reason ? ` attention ${reason}` : ''}">
      <div class="ws-card-top"><h3><button class="ws-card-title" data-open-conv="${esc(conv.id)}">${esc(conv.title || 'Conversation sans titre')}</button></h3><span class="ws-tag${reason === 'ask' ? ' accent' : ''}">${esc(REASONS[reason] || STATUS[conv.status] || conv.status)}</span></div>
      <div class="ws-card-meta"><span>${esc(PROVIDERS[conv.provider] || conv.provider)}</span><span>·</span><span>${esc(basename(project))}</span><span>·</span><time>${esc(date(conv.updatedAt))}</time></div>
      ${conv.ask ? `<p>${esc(short(conv.ask.question, 250))}</p>` : ''}
      ${conv.silent ? '<p>Le processus est toujours suivi, mais aucun nouvel événement n’est arrivé récemment.</p>' : ''}
      <div class="ws-actions"><button class="primary" data-open-conv="${esc(conv.id)}">${reason === 'ask' ? 'Répondre' : 'Ouvrir'}</button>
      <button data-budget-scope="conversation" data-budget-target="${esc(conv.id)}" data-budget-name="${esc(conv.title)}">Budget</button>
      ${conv.status !== 'working' ? `<button data-archive-conv="${esc(conv.id)}" data-archived="${conv.archived ? 'false' : 'true'}">${conv.archived ? 'Restaurer' : 'Archiver'}</button>` : ''}</div></article>`;
  }

  function alertCards(alerts) {
    return (alerts || []).filter((alert) => alert.state === 'active').map((alert) => {
      const conv = state().convs.find((item) => item.id === alert.target);
      const target = alert.scope === 'conversation' ? (conv && conv.title) || 'Conversation' : basename(alert.target);
      const format = (value) => alert.metric === 'costUsd' ? money(value) : alert.metric === 'timeMs' ? duration(value) : `${nf.format(value)} tokens`;
      return `<div class="ws-alert"><strong>${esc(target)} — seuil ${alert.metric === 'costUsd' ? 'de coût estimé' : alert.metric === 'timeMs' ? 'de durée' : 'de tokens'} atteint</strong><p>${esc(format(alert.value))} sur ${esc(format(alert.limit))} configurés.</p><div class="ws-actions"><button data-alert-snooze="${esc(alert.id)}">Me rappeler dans 1 h</button><button data-alert-dismiss="${esc(alert.id)}">J’ai vu</button><button data-budget-scope="${esc(alert.scope)}" data-budget-target="${esc(alert.target)}" data-budget-name="${esc(target)}">Modifier le seuil</button></div></div>`;
    }).join('');
  }

  function renderInbox(data) {
    const attention = data.attention || { items: [], counts: {} };
    const counts = attention.counts;
    let html = intro('Votre travail, au même endroit.', 'Les décisions, les erreurs et les résultats à relire passent en premier.', '<button class="primary" data-new-agent>Nouvel agent</button>');
    html += `<div class="ws-stats">${stat(counts.ask || 0, 'décisions attendues', true)}${stat(counts.done || 0, 'travaux à relire')}${stat(counts.working || 0, 'agents en cours')}${stat(counts.error || 0, 'erreurs à vérifier')}</div>`;
    html += alertCards(data.alerts);
    const urgent = attention.items.filter((item) => ['ask', 'error', 'silent'].includes(item.primary));
    const finished = attention.items.filter((item) => item.primary === 'done');
    const active = attention.items.filter((item) => item.primary === 'working');
    if (urgent.length) html += section('Votre attention', `<div class="ws-grid">${urgent.map((c) => conversationCard(c, c.primary)).join('')}</div>`, urgent.length);
    if (finished.length) html += section('Prêts à relire', `<div class="ws-grid">${finished.map((c) => conversationCard(c, 'done')).join('')}</div>`, finished.length);
    if (active.length) html += section('En cours', `<div class="ws-grid">${active.map((c) => conversationCard(c, 'working')).join('')}</div>`, active.length);
    if (!attention.items.length) html += empty('Tout est à jour.', 'Aucun agent ne demande votre attention pour le moment.');
    // Les cartes d'attention sont déjà les raccourcis prioritaires de cette page. Les
    // répéter dans « récents » gaspille l'espace qui doit justement faire remonter d'autres
    // fils utiles.
    const attentionIds = new Set(attention.items.map((item) => item.id));
    const recent = state().convs
      .filter((c) => !c.archived && !attentionIds.has(c.id))
      .slice(0, 6);
    if (recent.length) html += section('Reprendre un fil récent', `<div class="ws-grid">${recent.map((c) => conversationCard(c)).join('')}</div>`);
    return html;
  }

  function projectCard(project) {
    return `<article class="ws-card"><div class="ws-card-top"><h3><button class="ws-card-title" data-open-project="${esc(project.key)}">${esc(project.name)}</button></h3><span class="ws-tag">${project.conversations.active} fils</span></div>
      <p>${nf.format(project.notes.todo + project.notes.doing)} tâches ouvertes · ${nf.format(project.plans.total)} documents</p>${metrics(project.usage)}
      <div class="ws-actions"><button class="primary" data-open-project="${esc(project.key)}">Voir le projet</button><button data-budget-scope="project" data-budget-target="${esc(project.key)}" data-budget-name="${esc(project.name)}">Budget</button></div></article>`;
  }
  function renderProjects(data) {
    const rows = data.projects || [];
    return intro('Reprendre un projet.', 'Les conversations, la conception et les branches restent rassemblées autour du même travail.') +
      (rows.length ? `<div class="ws-grid">${rows.map(projectCard).join('')}</div>` : empty('Aucun projet pour le moment.', 'Les projets apparaissent dès qu’une conversation utilise un dossier de travail.'));
  }

  function branchCard(entry) {
    const info = entry.state || {};
    const owner = entry.owners && entry.owners[0];
    return `<article class="ws-card"><div class="ws-card-top"><h3>${esc(entry.branch || 'Dossier conservé')}</h3><span class="ws-tag${entry.orphan ? ' accent' : ''}">${entry.orphan ? 'À reprendre' : 'Rattachée'}</span></div>
      <p>${esc(basename(entry.repo))} · ${nf.format(info.dirty || 0)} fichier(s) non commités · ${nf.format(info.ahead || 0)} commit(s) d’avance</p>
      ${entry.error ? `<p class="error-text">${esc(entry.error)}</p>` : ''}
      ${entry.path ? `<details><summary class="ws-muted">Emplacement du travail</summary><code class="ws-path">${esc(entry.path)}</code></details>` : ''}
      <div class="ws-actions">${owner ? `<button class="primary" data-open-conv="${esc(owner)}">Ouvrir le fil</button>` : entry.canResume ? `<button class="primary" data-resume-worktree="${esc(entry.id)}">Reprendre le travail</button>` : ''}
      ${entry.worktree ? `<button data-diff-worktree="${esc(entry.id)}">Voir les changements</button>` : ''}
      ${entry.canMerge ? `<button data-merge-worktree="${esc(entry.id)}">Fusionner…</button>` : ''}</div></article>`;
  }
  function renderBranches(data) {
    worktreeRows = data.items || [];
    const counts = data.counts || {};
    return intro('Le travail Git reste accessible.', 'Retrouvez les branches actives et les dossiers conservés, même après la suppression de leur conversation.') +
      `<div class="ws-stats">${stat(counts.total || 0, 'branches suivies')}${stat(counts.orphan || 0, 'travaux à reprendre', true)}${stat(counts.dirty || 0, 'dossiers non commités')}${stat(counts.ahead || 0, 'branches en avance')}</div>` +
      (worktreeRows.length ? `<div class="ws-grid">${worktreeRows.map(branchCard).join('')}</div>` : empty('Aucune branche isolée.', 'Les branches et worktrees créés par agentHub apparaîtront ici.'));
  }

  function renderProject(data) {
    const project = data.project;
    document.querySelector('#workspace-title').textContent = project.name;
    worktreeRows = data.worktrees || [];
    const convs = data.conversations.filter((c) => !c.archived);
    const representative = convs[0] || data.conversations[0];
    let html = intro(project.name, `${project.conversations.active} fils actifs · ${project.conversations.archived} archivés`, `<button class="ws-small" data-budget-scope="project" data-budget-target="${esc(project.key)}" data-budget-name="${esc(project.name)}">Alertes de budget</button>`);
    html += `<div class="ws-stats">${stat(nf.format(data.usage.tokens || 0), 'tokens cumulés')}${stat(money(data.usage.costUsd), 'équivalent API estimé')}${stat(project.notes.todo + project.notes.doing, 'tâches ouvertes')}${stat(project.plans.total, 'documents de conception')}</div>`;
    html += section('Conversations', convs.length ? `<div class="ws-grid">${convs.map((c) => conversationCard(c)).join('')}</div>` : empty('Aucun fil actif.', 'Les conversations archivées restent disponibles dans Archives.'));
    const notes = data.notes || [];
    html += section('Notes et tâches', `<div class="ws-card">${notes.length ? notes.slice(0, 12).map((note) => `<div class="ws-line"><div class="ws-line-main"><strong>${esc(note.title)}</strong><p>${esc({ todo: 'À faire', doing: 'En cours', done: 'Terminé' }[note.status] || note.status)}</p></div></div>`).join('') : '<p>Aucune tâche enregistrée.</p>'}${representative ? `<div class="ws-actions"><button data-open-panel="notes" data-panel-conv="${esc(representative.id)}">Ouvrir le bloc-notes</button></div>` : ''}</div>`);
    const docs = (data.plans || []).flatMap((section) => section.docs || []);
    html += section('Plans et documentation', `<div class="ws-card">${docs.length ? docs.slice(0, 10).map((doc) => `<div class="ws-line"><div class="ws-line-main"><strong>${esc(doc.title || doc.name || doc.path)}</strong><p>${esc(doc.status || '')}</p></div></div>`).join('') : '<p>Aucun document découvert dans ce projet.</p>'}${representative ? `<div class="ws-actions"><button data-open-panel="plans" data-panel-conv="${esc(representative.id)}">Ouvrir les plans et schémas</button></div>` : ''}</div>`);
    html += section('Branches et changements', worktreeRows.length ? `<div class="ws-grid">${worktreeRows.map(branchCard).join('')}</div>` : empty('Aucune branche isolée pour ce projet.'));
    return html;
  }

  function options(rows, selected) {
    return rows.map(([value, title]) => `<option value="${esc(value)}"${String(selected || '') === String(value) ? ' selected' : ''}>${esc(title)}</option>`).join('');
  }
  function searchForm(data) {
    const filter = searchFilters;
    return `<form id="workspace-search-form" class="ws-filter-form"><div class="ws-search-row"><input aria-label="Rechercher dans les conversations" name="q" type="search" value="${esc(route.q || '')}" placeholder="Une erreur, un fichier, une décision…"><button class="primary" type="submit">Rechercher</button></div><div class="ws-filters">
      <label>Projet<select name="project">${options([['', 'Tous les projets'], ...(data.projects || []).map((p) => [p.key, p.name])], filter.project)}</select></label>
      <label>Agent<select name="provider">${options([['', 'Tous les agents'], ...Object.entries(PROVIDERS)], filter.provider)}</select></label>
      <label>État<select name="status">${options([['', 'Tous les états'], ...Object.entries(STATUS)], filter.status)}</select></label>
      <label>Type de message<select name="kind">${options([['', 'Tout le contenu'], ['user', 'Mes consignes'], ['text', 'Réponses'], ['tool', 'Outils'], ['thinking', 'Réflexion']], filter.kind)}</select></label>
      <label>À partir du<input type="date" name="from" value="${esc(filter.from || '')}"></label><label>Jusqu’au<input type="date" name="to" value="${esc(filter.to || '')}"></label>
      </div><label class="ws-check"><input type="checkbox" name="archived"${filter.archived ? ' checked' : ''}>Inclure les conversations archivées</label></form><div id="workspace-search-results"></div>`;
  }

  async function runSearch(scope) {
    const host = document.querySelector('#workspace-search-results');
    if (!host) return;
    host.innerHTML = '<div class="ws-loading">Recherche dans l’historique…</div>';
    const query = new URLSearchParams({ q: route.q || '' });
    for (const [key, value] of Object.entries(searchFilters)) if (value) query.set(key, key === 'archived' ? 'include' : value);
    try {
      const data = await request(`/api/search?${query}`, { signal: scope.signal });
      if (!scope.isCurrent() || !host.isConnected) return;
      if (!(route.q || '').trim()) {
        host.innerHTML = data.conversations.length ? `<div class="ws-grid">${data.conversations.map((c) => conversationCard(c)).join('')}</div>` : empty('Aucun fil ne correspond aux filtres.');
      } else {
        host.innerHTML = data.results.length ? `${section(`${data.results.length} conversation(s) trouvée(s)`, data.results.map((result) => `<article class="ws-card ws-section"><h3><button class="ws-card-title" data-open-conv="${esc(result.convId)}">${esc(result.title)}</button></h3>${result.matches.map((match) => `<button class="ws-search-hit" data-open-conv="${esc(result.convId)}" data-focus-item="${esc(match.itemId || '')}">${esc(match.snippet)}</button>`).join('')}</article>`).join(''))}${data.truncated ? '<p class="ws-muted">Affichage limité aux premiers résultats. Affinez les filtres pour aller plus loin.</p>' : ''}` : empty('Aucun résultat.', 'Essayez un terme plus court ou élargissez les filtres.');
      }
    } catch (err) {
      if (err.name !== 'AbortError' && scope.isCurrent()) host.innerHTML = empty('Recherche indisponible', err.message);
    }
  }

  async function open(next, { refresh = false } = {}) {
    if (!bridge() || !VIEWS.has(next.view)) return;
    route = { ...next };
    if (!refresh) bridge().showView('#workspace-view', { route: false, view: route.view, project: route.project, q: route.q });
    const serial = ++generation;
    const scope = newScope();
    document.querySelector('#workspace-title').textContent = TITLES[route.view];
    document.querySelectorAll('.ws-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.workspaceNav === (route.view === 'project' ? 'projects' : route.view)));
    if (!refresh) body.innerHTML = '<div class="ws-loading" role="status">Chargement de l’espace de travail…</div>';
    try {
      let html;
      if (route.view === 'worktrees') {
        const data = await request('/api/workspace/worktrees', { signal: scope.signal });
        if (!scope.isCurrent() || serial !== generation) return;
        html = renderBranches(data);
      } else if (route.view === 'project') {
        const data = await request(`/api/workspace/projects?key=${encodeURIComponent(route.project || '')}`, { signal: scope.signal });
        if (!scope.isCurrent() || serial !== generation) return;
        html = renderProject(data);
      } else {
        const data = await request('/api/workspace', { signal: scope.signal });
        if (!scope.isCurrent() || serial !== generation) return;
        overview = data; rules = data.rules || [];
        updateBadge(data);
        if (route.view === 'inbox') html = renderInbox(data);
        else if (route.view === 'projects') html = renderProjects(data);
        else if (route.view === 'archive') {
          const archived = state().convs.filter((conv) => conv.archived);
          html = intro('Garder l’historique, alléger le quotidien.', 'Les fils archivés sont conservés et restent cherchables. Vous pouvez les restaurer à tout moment.') +
            (archived.length ? `<div class="ws-grid">${archived.map((conv) => conversationCard(conv)).join('')}</div>` : empty('Aucune conversation archivée.', 'Archivez un fil terminé depuis son menu ou sa carte.'));
        } else html = intro('Retrouver le bon contexte.', 'Cherchez dans les consignes, réponses et sorties d’outils, puis ouvrez directement le passage trouvé.') + searchForm(data);
      }
      if (!scope.isCurrent() || serial !== generation) return;
      const top = body.scrollTop;
      body.innerHTML = `<div class="ws-wrap">${html}</div>`;
      if (refresh) body.scrollTop = top;
      if (route.view === 'search') await runSearch(scope);
    } catch (err) {
      if (err.name !== 'AbortError' && scope.isCurrent()) body.innerHTML = `${empty('L’espace de travail est indisponible.', err.message)}<div class="ws-actions"><button data-retry-workspace>Réessayer</button></div>`;
    }
  }

  function updateBadge(data) {
    const badge = document.querySelector('#workspace-badge');
    const count = (data.attention && data.attention.counts.total || 0) + (data.alerts || []).filter((a) => a.state === 'active').length;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', !count);
  }

  async function editBudget(scopeName, target, name) {
    const context = global.AgentHubActionContext.capture();
    let fields;
    try {
      const data = await request('/api/workspace/budgets', { signal: context.signal });
      if (!context.isCurrent()) return;
      rules = data.rules || [];
      const rule = rules.find((row) => row.scope === scopeName && row.target === target);
      const limits = rule ? rule.limits : {};
      const accepted = await global.openDialog({
        title: `Alertes · ${name || 'Budget'}`, cancelValue: false,
        bodyHtml: `<div class="ws-budget-form"><p class="ws-budget-note">Une alerte lorsque le total connu du ${scopeName === 'project' ? 'projet' : 'fil'} dépasse un seuil, historique compris. Ces limites n’interrompent pas les agents.</p><label>Durée cumulée (minutes)<input id="ws-budget-time" type="number" min="1" step="1" placeholder="Sans seuil" value="${limits.timeMs ? Math.ceil(limits.timeMs / 60000) : ''}"></label><label>Tokens cumulés<input id="ws-budget-tokens" type="number" min="1" step="1000" placeholder="Sans seuil" value="${limits.tokens || ''}"></label><label>Coût API estimé (USD)<input id="ws-budget-cost" type="number" min="0.01" step="0.01" placeholder="Sans seuil" value="${limits.costUsd || ''}"></label><p class="ws-budget-note">Les coûts dépendent des relevés disponibles. Les anciennes durées manquantes ne sont pas inventées.</p></div>`,
        buttons: [{ label: 'Annuler', value: false }, ...(rule ? [{ label: 'Retirer les alertes', value: 'remove', danger: true }] : []), { label: 'Enregistrer', value: true, primary: true }],
        buildBody: (host) => {
          fields = {
            time: host.querySelector('#ws-budget-time'),
            tokens: host.querySelector('#ws-budget-tokens'),
            cost: host.querySelector('#ws-budget-cost'),
          };
        },
      });
      if (!accepted || !context.isCurrent()) return;
      const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
      if (accepted === 'remove') await request(`/api/workspace/budgets/${rule.id}`, { method: 'DELETE' });
      else {
        const configured = {};
        if (values && values.time) configured.timeMs = Number(values.time) * 60000;
        if (values && values.tokens) configured.tokens = Number(values.tokens);
        if (values && values.cost) configured.costUsd = Number(values.cost);
        if (!Object.keys(configured).length) throw new Error('Renseignez au moins un seuil.');
        await request('/api/workspace/budgets', { method: 'POST', body: { id: rule && rule.id, scope: scopeName, target, limits: configured } });
      }
      global.toast('Alertes de budget enregistrées.');
      if (visible()) open(route, { refresh: true });
    } catch (err) { if (err.name !== 'AbortError') global.toastError(err.message); }
    finally { context.release(); }
  }

  async function landmarks() {
    const conv = state().current;
    if (!conv) return;
    const ctx = global.AgentHubActionContext.capture({ conversationId: conv.id });
    try {
      const data = await request(`/api/conversations/${conv.id}/landmarks`, { signal: ctx.signal });
      if (!ctx.isCurrent()) return;
      const html = `<p class="ws-muted">${nf.format(data.totalTurns)} consignes · ${nf.format(data.totalItems)} éléments. Repères extraits du fil, sans génération supplémentaire.</p>` +
        (data.latest ? `<details open><summary>Dernière réponse</summary><div class="ws-last-answer">${esc(data.latest.text)}</div></details>` : '') +
        `<div class="ws-landmark-list">${data.turns.length ? data.turns.map((turn, i) => `<button class="ws-landmark" data-open-conv="${esc(conv.id)}" data-focus-item="${esc(turn.id)}"><small>${i + 1} · ${esc(date(turn.ts))}</small><strong>${esc(turn.text)}</strong></button>`).join('') : '<p class="ws-muted">Aucune consigne enregistrée.</p>'}</div>` +
        (data.files.length ? `<details><summary>Fichiers mentionnés récemment</summary>${data.files.map((file) => `<button class="ws-landmark" data-open-conv="${esc(conv.id)}" data-focus-item="${esc(file.itemId)}"><code class="ws-path">${esc(file.path)}</code></button>`).join('')}</details>` : '');
      const decision = global.openDialog({ title: 'Repères du fil', bodyHtml: html, cancelValue: false, buttons: [{ label: 'Fermer', value: false }, { label: 'Alertes de budget', value: 'budget' }] });
      document.querySelector('.dialog-box')?.classList.add('ws-dialog-wide');
      if (await decision === 'budget' && ctx.isCurrent()) editBudget('conversation', conv.id, conv.title);
    } catch (err) { if (err.name !== 'AbortError') global.toastError(err.message); }
    finally { ctx.release(); }
  }

  async function diffWorktree(id) {
    const row = worktreeRows.find((entry) => entry.id === id);
    const ctx = global.AgentHubActionContext.capture();
    try {
      const data = await request(`/api/workspace/worktrees/${id}/diff`, { signal: ctx.signal });
      if (!ctx.isCurrent()) return;
      const html = `<p class="ws-muted">${esc(data.branch)} → ${esc(data.target)}</p>${data.status ? `<p class="ws-muted">État des fichiers</p><pre class="ws-diff">${esc(data.status)}</pre>` : ''}<pre class="ws-diff">${esc(data.text || 'Aucun changement à afficher.')}</pre>${data.truncated ? '<p class="ws-muted">Aperçu limité. Le travail complet est conservé dans le dépôt.</p>' : ''}`;
      const decision = global.openDialog({ title: 'Relire les changements', bodyHtml: html, cancelValue: false, buttons: [{ label: 'Fermer', value: false }, ...(row && row.canMerge ? [{ label: 'Fusionner…', value: 'merge', primary: true }] : [])] });
      document.querySelector('.dialog-box')?.classList.add('ws-dialog-wide');
      if (await decision === 'merge' && ctx.isCurrent()) await mergeWorktree(id);
    } catch (err) { if (err.name !== 'AbortError') global.toastError(err.message); }
    finally { ctx.release(); }
  }

  async function mergeWorktree(id) {
    const row = worktreeRows.find((entry) => entry.id === id);
    if (!row) return;
    const ctx = global.AgentHubActionContext.capture();
    try {
      const yes = await global.askConfirm({ title: 'Fusionner cette branche ?', body: `${row.branch}\nVers ${row.state.target || 'la branche du projet'}\n\nGit vérifiera de nouveau l’état des dossiers et les conflits avant la fusion.`, ok: 'Fusionner' });
      if (!yes || !ctx.isCurrent()) return;
      await request(`/api/workspace/worktrees/${id}/merge`, { method: 'POST' });
      global.toast('Branche fusionnée.');
      if (visible()) open(route, { refresh: true });
    } catch (err) { global.toastError(err.message); }
    finally { ctx.release(); }
  }

  async function resumeWorktree(id) {
    const row = worktreeRows.find((entry) => entry.id === id);
    if (!row) return;
    const ctx = global.AgentHubActionContext.capture();
    let picker;
    const accepted = await global.openDialog({
      title: 'Reprendre le travail', body: row.branch, cancelValue: false,
      buildBody: (host) => {
        const label = document.createElement('label'); label.textContent = 'Agent de la nouvelle conversation';
        picker = document.createElement('select'); picker.className = 'ws-agent-select';
        picker.innerHTML = options(Object.entries(PROVIDERS), state().provider);
        label.append(picker); host.append(label);
      }, buttons: [{ label: 'Annuler', value: false }, { label: 'Ouvrir une conversation', value: true, primary: true }],
    });
    if (!accepted || !ctx.isCurrent()) { ctx.release(); return; }
    try {
      const data = await request(`/api/workspace/worktrees/${id}/resume`, { method: 'POST', body: { provider: picker.value } });
      if (!ctx.isCurrent()) return;
      await bridge().refreshList();
      global.toast('Travail rattaché à une nouvelle conversation. Aucun agent n’a été lancé.');
      await bridge().openConversation(data.conversation.id);
    } catch (err) { global.toastError(err.message); }
    finally { ctx.release(); }
  }

  async function action(button, run) {
    if (button.disabled) return;
    button.disabled = true;
    try { await run(); } catch (err) { if (err.name !== 'AbortError') global.toastError(err.message); }
    finally { if (button.isConnected) button.disabled = false; }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.workspaceNav) { navigate({ view: data.workspaceNav }); return; }
    if (data.openConv) { global.closeDialog(); bridge().openConversation(data.openConv, data.focusItem || null); return; }
    if (data.openProject) { navigate({ view: 'project', project: data.openProject }); return; }
    if (data.newAgent !== undefined) { bridge().showNew(); return; }
    if (data.retryWorkspace !== undefined) { open(route); return; }
    if (data.openPanel) { bridge().openPanel(data.openPanel, data.panelConv); return; }
    if (data.conversationLandmarks !== undefined) { document.querySelector('#mobile-head-menu').classList.add('hidden'); landmarks(); return; }
    if (data.currentBudget !== undefined) {
      const conv = state().current;
      document.querySelector('#mobile-head-menu').classList.add('hidden');
      if (conv) editBudget('conversation', conv.id, conv.title);
      return;
    }
    if (data.budgetScope) { editBudget(data.budgetScope, data.budgetTarget, data.budgetName); return; }
    if (data.diffWorktree) return action(button, () => diffWorktree(data.diffWorktree));
    if (data.mergeWorktree) return action(button, () => mergeWorktree(data.mergeWorktree));
    if (data.resumeWorktree) return action(button, () => resumeWorktree(data.resumeWorktree));
    if (data.archiveConv) return action(button, async () => {
      await request(`/api/conversations/${data.archiveConv}`, { method: 'PATCH', body: { archived: data.archived === 'true' } });
      await bridge().refreshList();
      if (visible()) open(route, { refresh: true });
      global.toast(data.archived === 'true' ? 'Conversation archivée. Son historique est conservé.' : 'Conversation restaurée.');
    });
    if (data.alertDismiss || data.alertSnooze) return action(button, async () => {
      await request(`/api/workspace/alerts/${data.alertDismiss ? 'dismiss' : 'snooze'}`, { method: 'POST', body: { id: data.alertDismiss || data.alertSnooze } });
      if (visible()) open(route, { refresh: true });
    });
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'workspace-search-form') return;
    event.preventDefault();
    const form = new FormData(event.target);
    searchFilters = Object.fromEntries(['project', 'provider', 'status', 'kind', 'from', 'to'].map((key) => [key, form.get(key) || '']));
    searchFilters.archived = Boolean(form.get('archived'));
    const next = { view: 'search', q: String(form.get('q') || '').trim() };
    if ((route.q || '') === next.q) open(next, { refresh: true });
    else navigate(next);
  });

  document.querySelector('#btn-workspace-menu').addEventListener('click', () => {
    document.body.classList.add('nav-open');
  });
  document.querySelector('#btn-workspace-refresh').addEventListener('click', () => open(route, { refresh: true }));
  global.addEventListener('agenthub:route', (event) => {
    if (VIEWS.has(event.detail.view)) open(event.detail);
  });
  global.addEventListener('agenthub:activity', (event) => {
    if (!visible() || ['search', 'project', 'archive', 'worktrees'].includes(route.view)) return;
    if (['item', 'delta', 'itemUpdate'].includes((event.detail || {}).type)) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (visible()) open(route, { refresh: true }); }, 2000);
  });

  async function pollBudgets() {
    if (document.visibilityState !== 'visible' || !bridge()) return;
    try {
      const data = await request('/api/workspace/attention');
      const activeIds = new Set((data.alerts || []).filter((alert) => alert.state === 'active').map((alert) => alert.id));
      for (const id of shownAlerts) if (!activeIds.has(id)) shownAlerts.delete(id);
      for (const alert of data.alerts || []) {
        if (alert.state !== 'active' || shownAlerts.has(alert.id)) continue;
        if (!visible()) {
          shownAlerts.add(alert.id);
          global.toast('Un seuil de budget est atteint.', { action: { label: 'Voir', run: () => navigate({ view: 'inbox' }) }, ms: 10_000 });
        }
      }
      updateBadge(data);
    } catch { /* une indisponibilité de télémétrie ne bloque pas le travail */ }
  }
  setInterval(pollBudgets, 30_000);
  document.addEventListener('visibilitychange', pollBudgets);
  global.AgentHubWorkspace = { open, refresh: () => open(route, { refresh: true }), editBudget };
})(window);
