'use strict';

// Trois agents qui se passent le relais sur un ticket.
//
// agentHub savait déjà lancer une conversation, et en dériver une autre à la main. Ce module
// enchaîne : **planifier**, puis **coder**, puis **relire** — chacun dans sa conversation, la
// sortie de l'un devenant l'entrée du suivant.
//
// Ce que ça n'est pas : un orchestrateur qui cache ses agents. Chaque étape est une
// conversation ordinaire, visible dans la sidebar, qu'on peut lire, reprendre, interrompre ou
// dériver. Une équipe n'est qu'un fil rouge entre trois d'entre elles.
//
// Deux choix qui structurent tout le reste :
//
// - **Le codeur est isolé, les deux autres non.** Il travaille dans un worktree à lui, sur sa
//   branche. Le planificateur ne fait que lire, et le relecteur lit la branche depuis le
//   dépôt principal — pas depuis le worktree. Sans ça, supprimer la conversation du codeur
//   emporterait le worktree et couperait le sol sous le relecteur.
// - **Le relecteur vient d'un autre fournisseur.** Un modèle qui relit son propre travail
//   valide ses propres angles morts ; c'est la seule chose qu'agentHub peut offrir et qu'un
//   orchestrateur mono-vendeur ne peut pas.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'teams.json');

/** Les trois étapes, dans l'ordre. `isolate` dit qui reçoit un worktree. */
const STAGES = [
  { key: 'plan', label: 'Plan', isolate: false },
  { key: 'build', label: 'Réalisation', isolate: true },
  { key: 'review', label: 'Relecture', isolate: false },
];

const KEYS = STAGES.map((s) => s.key);

/**
 * Fournisseur de relecture, selon celui qui a codé.
 *
 * Le but n'est pas de trouver « le meilleur relecteur » mais **un autre regard**. L'ordre de
 * préférence est fixe et volontairement bête : ce qui compte est que ce ne soit pas le même.
 */
const OTHER = { claude: ['codex', 'grok'], codex: ['claude', 'grok'], grok: ['claude', 'codex'] };

function reviewerFor(builder, available) {
  const usable = new Set(available && available.length ? available : Object.keys(OTHER));
  const found = (OTHER[builder] || []).find((p) => usable.has(p));
  // Aucun autre fournisseur disponible : on relit avec le même plutôt que de sauter l'étape.
  // Un relecteur qui partage les angles morts vaut mieux que pas de relecture du tout.
  return found || builder;
}

function read() {
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function write(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows.slice(-100), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/**
 * Ouvre une équipe sur un ticket. L'étape n'est pas encore lancée : c'est l'appelant qui
 * crée les conversations, ce module ne connaît ni le store ni le lanceur.
 */
function open({ ticketId, ticketTitle, project, provider, reviewer }) {
  const run = {
    id: crypto.randomUUID(),
    ticketId: String(ticketId || ''),
    ticketTitle: String(ticketTitle || '').slice(0, 200),
    project: String(project || ''),
    provider: provider || 'claude',
    reviewer: reviewer || reviewerFor(provider || 'claude'),
    stage: 'plan',
    convs: {},
    status: 'running',
    createdAt: new Date().toISOString(),
    endedAt: null,
    stoppedWhy: null,
  };
  const rows = read();
  rows.push(run);
  write(rows);
  return run;
}

function get(id) {
  return read().find((r) => r.id === id) || null;
}

function list(project) {
  const rows = read();
  return project ? rows.filter((r) => r.project === project) : rows;
}

/** L'équipe à laquelle appartient une conversation, et à quelle étape. */
function forConv(convId) {
  for (const run of read()) {
    for (const key of KEYS) {
      if (run.convs[key] === convId) return { run, stage: key };
    }
  }
  return null;
}

function update(id, patch) {
  const rows = read();
  const run = rows.find((r) => r.id === id);
  if (!run) return null;
  Object.assign(run, patch);
  write(rows);
  return run;
}

/** Note la conversation qui porte une étape. */
function attach(id, stage, convId) {
  const run = get(id);
  if (!run) return null;
  return update(id, { convs: { ...run.convs, [stage]: convId }, stage });
}

/**
 * Que faire quand l'étape `stage` d'une équipe vient de se terminer.
 *
 * Un échec **arrête la chaîne** au lieu de la poursuivre : coder sur un plan qui n'existe
 * pas, ou relire un travail qui a planté, ne produit que du bruit et coûte deux turns.
 *
 * @returns {{action: 'next', stage: string} | {action: 'finish'} | {action: 'stop', why: string}}
 */
function next(stage, outcome) {
  if (outcome !== 'done') {
    return { action: 'stop', why: `étape « ${labelOf(stage)} » ${outcome === 'stopped' ? 'interrompue' : 'en échec'}` };
  }
  const at = KEYS.indexOf(stage);
  if (at === -1) return { action: 'stop', why: 'étape inconnue' };
  if (at === KEYS.length - 1) return { action: 'finish' };
  return { action: 'next', stage: KEYS[at + 1] };
}

function labelOf(key) {
  const found = STAGES.find((s) => s.key === key);
  return found ? found.label : key;
}

function isolates(key) {
  const found = STAGES.find((s) => s.key === key);
  return Boolean(found && found.isolate);
}

// --- Les consignes ----------------------------------------------------------
//
// Chaque étape reçoit le ticket, plus ce que l'étape précédente a produit. Les consignes
// disent aussi ce qu'il ne faut **pas** faire : le planificateur qui se met à coder est le
// mode d'échec le plus courant de ce genre de chaîne.

function planPrompt(ticket) {
  return [
    `Ticket « ${ticket.title} » (id ${ticket.id})`,
    ticket.body ? `\n${ticket.body}` : '',
    '',
    'Tu es la première étape d’une équipe de trois. Ton rôle est de **planifier, pas de',
    'coder** : ne modifie aucun fichier, n’en crée aucun.',
    '',
    'Lis ce qui existe, puis rends un plan court et concret : les fichiers à toucher, dans',
    'quel ordre, et les pièges que tu as repérés en lisant. Si le ticket est ambigu au point',
    'que deux plans opposés se défendent, dis-le plutôt que de choisir en silence.',
    '',
    'Ta réponse finale sera donnée telle quelle à celui qui code : écris-la pour lui.',
  ].join('\n');
}

function buildPrompt(ticket, plan, branch) {
  return [
    `Ticket « ${ticket.title} » (id ${ticket.id})`,
    ticket.body ? `\n${ticket.body}` : '',
    '',
    '--- Plan produit par l’étape précédente ---',
    plan || '(aucun plan n’a été rendu — travaille depuis le ticket seul)',
    '--- fin du plan ---',
    '',
    'Tu es la deuxième étape. Réalise ce travail.',
    branch
      ? `Tu es dans un worktree isolé, sur la branche \`${branch}\` : tu ne gênes personne, et ` +
        '**commite ton travail** pour que le relecteur puisse le lire.'
      : "Ce projet n’est pas versionné : travaille directement, il n’y a pas de branche.",
    '',
    'Le plan est un point de départ, pas un ordre : si tu découvres en codant qu’il se',
    'trompe, écarte-t’en et dis en quoi.',
  ].join('\n');
}

function reviewPrompt(ticket, branch, base) {
  return [
    `Relecture du ticket « ${ticket.title} » (id ${ticket.id})`,
    ticket.body ? `\n${ticket.body}` : '',
    '',
    'Tu es la troisième étape, et tu viens d’un autre fournisseur que celui qui a codé —',
    'c’est le but : un modèle qui relit son propre travail valide ses propres angles morts.',
    '',
    branch
      ? `Le travail est sur la branche \`${branch}\`. Lis-le avec :\n` +
        `    git diff ${base || 'HEAD'}...${branch}\n` +
        'Tu es dans le dépôt principal : **ne modifie rien**, ne bascule pas de branche.'
      : 'Le projet n’est pas versionné : lis les fichiers concernés et juge sur pièces.',
    '',
    'Rends un avis court et tranché : ce qui est juste, ce qui est faux, ce qui manque.',
    'Ne réécris pas le code — dis ce qui ne va pas et pourquoi. Si tout tient, dis-le en une',
    'phrase plutôt que d’inventer des réserves pour faire bonne mesure.',
  ].join('\n');
}

function forget(ticketId) {
  const rows = read();
  const kept = rows.filter((r) => r.ticketId !== ticketId);
  if (kept.length !== rows.length) write(kept);
  return rows.length - kept.length;
}

module.exports = {
  FILE,
  STAGES,
  KEYS,
  reviewerFor,
  open,
  get,
  list,
  forConv,
  update,
  attach,
  next,
  labelOf,
  isolates,
  planPrompt,
  buildPrompt,
  reviewPrompt,
  forget,
};
