'use strict';

// Projection légère de l'espace de travail. Ce module ne lit jamais un fil : il compose les
// index et résumés injectés, donc reste indépendant de la taille des conversations.

const path = require('path');

const ATTENTION_ORDER = ['ask', 'error', 'silent', 'done', 'working'];

function projectKey(value) {
  const key = String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/[/\\]+$/, '');
  return key || null;
}

function projectOf(conv) {
  if (!conv) return null;
  return projectKey(
    (conv.worktree && conv.worktree.repo) || conv.project || conv.cwd
  );
}

function emptyUsage() {
  return {
    turns: 0,
    durationMs: 0,
    timeMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    tokens: 0,
    costUsd: 0,
    costEstimated: true,
    unknownCost: false,
  };
}

function attention({ conversations, asks, silent } = {}) {
  const pending = new Map((asks || []).map((ask) => [ask.convId, ask]));
  const muted = new Map((silent || []).map((row) => [row.convId, row]));
  const counts = { ask: 0, error: 0, silent: 0, done: 0, working: 0, total: 0 };
  const items = [];

  for (const conv of conversations || []) {
    if (!conv || !conv.id || conv.archived) continue;
    const reasons = [];
    if (pending.has(conv.id)) reasons.push('ask');
    if (conv.status === 'error') reasons.push('error');
    if (muted.has(conv.id)) reasons.push('silent');
    if (conv.status === 'done') reasons.push('done');
    if (conv.status === 'working') reasons.push('working');
    if (!reasons.length) continue;
    for (const reason of reasons) counts[reason] += 1;
    items.push({
      id: conv.id,
      title: conv.title || 'Conversation sans titre',
      provider: conv.provider || null,
      status: conv.status || 'idle',
      updatedAt: conv.updatedAt || null,
      project: projectOf(conv),
      primary: ATTENTION_ORDER.find((reason) => reasons.includes(reason)),
      reasons,
      ask: pending.get(conv.id) || null,
      silent: muted.get(conv.id) || null,
    });
  }

  items.sort((a, b) => {
    const priority = ATTENTION_ORDER.indexOf(a.primary) - ATTENTION_ORDER.indexOf(b.primary);
    return priority || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  counts.total = items.length;
  return { items, counts };
}

function summarizeNotes(rows) {
  const out = { total: 0, todo: 0, doing: 0, done: 0 };
  for (const row of rows || []) {
    out.total += 1;
    if (Object.hasOwn(out, row.status)) out[row.status] += 1;
  }
  return out;
}

function summarizePlans(sections) {
  const byStatus = {};
  let total = 0;
  for (const section of sections || []) {
    for (const doc of section.docs || []) {
      total += 1;
      const status = doc.status || 'autre';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
  }
  return { total, byStatus };
}

function projectSummaries({ folders, conversations, notesFor, plansFor, usage } = {}) {
  const byKey = new Map();
  const ensure = (key) => {
    const normalized = projectKey(key);
    if (!normalized) return null;
    if (!byKey.has(normalized)) {
      byKey.set(normalized, {
        key: normalized,
        path: normalized,
        name: path.basename(normalized) || normalized,
        folderIds: [],
        folderNames: [],
        conversations: { total: 0, active: 0, archived: 0, byStatus: {} },
      });
    }
    return byKey.get(normalized);
  };

  for (const folder of folders || []) {
    const project = ensure(folder && folder.cwd);
    if (!project) continue;
    if (folder.id && !project.folderIds.includes(folder.id)) project.folderIds.push(folder.id);
    if (folder.name && !project.folderNames.includes(folder.name)) project.folderNames.push(folder.name);
    if (folder.name) project.name = folder.name;
  }

  for (const conv of conversations || []) {
    const project = ensure(projectOf(conv));
    if (!project) continue;
    project.conversations.total += 1;
    if (conv.archived) project.conversations.archived += 1;
    else project.conversations.active += 1;
    const status = conv.status || 'idle';
    project.conversations.byStatus[status] =
      (project.conversations.byStatus[status] || 0) + 1;
  }

  const metrics = usage || {};
  // Le journal survit aux conversations et aux dossiers. Un projet historique avec du coût
  // reste donc visible même si ses derniers fils ont été supprimés.
  for (const key of Object.keys(metrics)) ensure(key);
  const latest = new Map();
  for (const conv of conversations || []) {
    const key = projectOf(conv);
    if (key && String(conv.updatedAt || '') > (latest.get(key) || '')) latest.set(key, conv.updatedAt);
  }
  return [...byKey.values()]
    .map((project) => ({
      ...project,
      notes: summarizeNotes(typeof notesFor === 'function' ? notesFor(project.key) : []),
      plans: summarizePlans(typeof plansFor === 'function' ? plansFor(project.key) : []),
      usage: { ...emptyUsage(), ...(metrics[project.key] || {}) },
    }))
    .sort(
      (a, b) =>
        String(latest.get(b.key) || '').localeCompare(String(latest.get(a.key) || '')) ||
        a.name.localeCompare(b.name)
    );
}

function worktreeView(items) {
  const rows = Array.isArray(items) ? items : (items && items.items) || [];
  return {
    items: rows,
    counts: {
      total: rows.length,
      orphan: rows.filter((row) => row.orphan).length,
      dirty: rows.filter((row) => row.state && row.state.dirty).length,
      ahead: rows.filter((row) => row.state && row.state.ahead).length,
    },
  };
}

function create(deps) {
  const source = deps || {};
  const call = (name, fallback) =>
    typeof source[name] === 'function' ? source[name]() : fallback;
  const snapshots = () => ({
    conversations: call('listConversations', []),
    folders: call('listFolders', []),
    usage: call('usageBreakdown', { conversations: {}, projects: {} }),
  });

  const service = {
    attention() {
      return attention({
        conversations: call('listConversations', []),
        asks: call('listAsks', []),
        silent: call('listSilent', []),
      });
    },
    overview() {
      const { conversations, folders, usage } = snapshots();
      return {
        attention: attention({
          conversations,
          asks: call('listAsks', []),
          silent: call('listSilent', []),
        }),
        projects: projectSummaries({
          folders,
          conversations,
          notesFor: source.notesFor,
          plansFor: source.plansFor,
          usage: usage.projects,
        }),
      };
    },

    async worktrees() {
      const rows =
        typeof source.inventoryWorktrees === 'function' ? await source.inventoryWorktrees() : [];
      return worktreeView(rows);
    },

    async project(key) {
      const wanted = projectKey(key);
      const { conversations, folders, usage } = snapshots();
      // Valider la clé contre l'index applicatif avant tout parcours de fichiers.
      const known = projectSummaries({ folders, conversations, usage: usage.projects });
      if (!wanted || !known.some((row) => row.key === wanted)) return null;
      const notes = typeof source.notesFor === 'function' ? source.notesFor(wanted) : [];
      const plans = typeof source.plansFor === 'function' ? source.plansFor(wanted) : [];
      const summaries = projectSummaries({
        folders,
        conversations,
        notesFor: (project) => (project === wanted ? notes : []),
        plansFor: (project) => (project === wanted ? plans : []),
        usage: usage.projects,
      });
      const project = summaries.find((row) => row.key === wanted) || null;
      if (!project) return null;
      const inventory = await service.worktrees();
      return {
        project,
        conversations: conversations
          .filter((conv) => projectOf(conv) === wanted)
          .map((conv) => ({ ...conv, project: wanted })),
        notes,
        plans,
        usage: { ...emptyUsage(), ...((usage.projects && usage.projects[wanted]) || {}) },
        worktrees: inventory.items.filter((row) => projectKey(row.repo) === wanted),
        landmarks:
          typeof source.landmarksFor === 'function' ? await source.landmarksFor(wanted) : [],
      };
    },
  };
  return service;
}

module.exports = {
  ATTENTION_ORDER,
  projectKey,
  projectOf,
  attention,
  summarizeNotes,
  summarizePlans,
  projectSummaries,
  worktreeView,
  create,
};
