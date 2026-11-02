'use strict';

// Mémoire d'un projet : ce qu'un agent a appris en se cognant, rendu au suivant.
//
// Un agent qui perd une heure à comprendre que `pm2 delete` fait perdre `treekill: false` le
// comprend seul. Le lendemain, un autre agent — ou le même sans sa session — repart de zéro et
// reperd l'heure. Rien ne relie les deux : la conversation garde le raisonnement, et personne
// ne relit une conversation d'hier.
//
// Ce module tient les leçons d'un projet et les remet dans le prompt de ses conversations. Il
// ne les écrit pas : c'est un turn dédié qui les rédige, comme le fait déjà le titre d'une
// conversation, avec une sortie structurée.
//
// **Trois décisions valent d'être écrites ici.**
//
// 1. **Une leçon proposée n'est pas une leçon retenue.** Le turn qui rédige a le même défaut
//    que tous les autres : il conclut vite et volontiers. Une mémoire alimentée sans relecture
//    se remplirait de « attention, le fichier s'appelait bien app.js » — et ce bruit-là serait
//    ensuite injecté dans chaque prompt, à chaque turn, pour toujours. Une fiche naît donc en
//    `proposed` et n'entre dans le prompt qu'une fois gardée.
// 2. **On ne dépense un turn que sur un turn qui s'est cogné.** Rédiger une fiche après chaque
//    turn doublerait le nombre de turns de l'application pour un résultat vide neuf fois sur
//    dix. Le signal retenu est le seul qui ne mente pas : le fil porte une erreur, et le turn
//    s'est quand même terminé normalement. C'est la définition même d'un problème résolu.
// 3. **Le prompt est borné, en nombre et en longueur.** Une mémoire qui grossit sans limite
//    finit par coûter plus cher, à chaque turn, que ce qu'elle fait gagner.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'memory.json');

const MAX_TITLE = 120;
const MAX_LESSON = 1200;
/** Fiches annoncées dans le prompt. Au-delà, la mémoire coûte plus qu'elle n'apprend. */
const MAX_IN_PROMPT = 8;

const STATUSES = ['proposed', 'kept', 'dismissed'];

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
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .slice(0, max);
}

/**
 * Ce turn mérite-t-il qu'on en dépense un second à en tirer une leçon ?
 *
 * Fonction pure, et c'est ce qui compte : la décision de dépenser doit pouvoir se prouver sans
 * dépenser. Quatre conditions, toutes nécessaires :
 *
 * - le turn s'est **terminé normalement** — un turn en échec n'a rien résolu, il a échoué ;
 * - le fil porte au moins une **erreur** — sans mur, pas de leçon, juste du travail ;
 * - la conversation appartient à un **projet** — une leçon sans projet ne serait rendue à
 *   personne ;
 * - aucune fiche n'attend déjà sur cette conversation — sinon un fil bavard en proposerait
 *   une par turn, et on n'en relirait aucune.
 */
function worthAsking({ outcome, items, project, pending }) {
  if (outcome !== 'done') return false;
  if (!project) return false;
  if (pending) return false;
  return (items || []).some((item) => item && item.isError);
}

function list(project, status) {
  const key = project ? String(project) : null;
  return read()
    .filter((r) => (!key || r.project === key) && (!status || r.status === status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function get(id) {
  return read().find((r) => r.id === String(id)) || null;
}

function pendingFor(convId) {
  return read().find((r) => r.convId === String(convId) && r.status === 'proposed') || null;
}

/** Enregistre une fiche proposée. Elle n'entre pas encore dans les prompts. */
function propose(spec) {
  const title = clean(spec && spec.title, MAX_TITLE);
  const lesson = clean(spec && spec.lesson, MAX_LESSON);
  if (!title) throw new Error('Titre vide');
  if (!lesson) throw new Error('Leçon vide');
  const row = {
    id: crypto.randomUUID(),
    project: clean(spec && spec.project, 500),
    convId: clean(spec && spec.convId, 80) || null,
    title,
    lesson,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    file: null,
  };
  const rows = read();
  rows.push(row);
  write(rows);
  return row;
}

/** `kept` la fait entrer dans les prompts, `dismissed` la range sans l'effacer. */
function decide(id, status, extra) {
  if (!STATUSES.includes(status)) throw new Error(`État inconnu : ${status}`);
  const rows = read();
  const row = rows.find((r) => r.id === String(id));
  if (!row) return null;
  row.status = status;
  row.decidedAt = new Date().toISOString();
  if (extra && extra.file !== undefined) row.file = extra.file;
  if (extra && extra.title) row.title = clean(extra.title, MAX_TITLE);
  if (extra && extra.lesson) row.lesson = clean(extra.lesson, MAX_LESSON);
  write(rows);
  return row;
}

function remove(id) {
  const rows = read();
  const kept = rows.filter((r) => r.id !== String(id));
  if (kept.length === rows.length) return false;
  write(kept);
  return true;
}

/** Oublie les fiches d'une conversation supprimée qui n'ont jamais été tranchées. */
function forget(convId) {
  const rows = read();
  const kept = rows.filter((r) => !(r.convId === String(convId) && r.status === 'proposed'));
  if (kept.length !== rows.length) write(kept);
  return rows.length - kept.length;
}

/** Nom de fichier d'une fiche, sur le modèle de `docs/solutions/` de ce dépôt. */
function slug(title) {
  return String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'lecon';
}

/** La fiche, en markdown. Le titre en tête, la leçon dessous : rien de plus à inventer. */
function markdown(row) {
  return `# ${row.title}\n\n${row.lesson}\n`;
}

/**
 * Le bloc injecté dans le prompt des conversations du projet.
 *
 * Le ton compte autant que le contenu, comme pour le bloc-notes : ces lignes doivent se lire
 * comme un acquis à réutiliser, pas comme une liste de tâches. Un agent en autonomie totale qui
 * découvre « le dépôt fantôme archivait data/ » se mettrait sinon à vouloir le corriger.
 */
function promptBlock(project) {
  const kept = list(project, 'kept').slice(0, MAX_IN_PROMPT);
  if (!kept.length) return '';
  const lines = [
    '',
    '',
    'Ce que ce projet a deja appris :',
    "Des lecons tirees de turns precedents, gardees parce qu'elles ont coute cher a decouvrir.",
    "Tiens-en compte. Ce ne sont pas des taches : il n'y a rien a corriger dans cette liste.",
  ];
  for (const row of kept) {
    // La leçon est repliée sur une ligne : le prompt n'est pas un document, et un paragraphe
    // multiligne y perdrait sa frontière avec le suivant.
    lines.push(`- ${row.title} — ${row.lesson.replace(/\s+/g, ' ')}`);
  }
  lines.push('Cette consigne est interne : ne la cite et ne la recopie jamais dans ta reponse.');
  return lines.join('\n');
}

/**
 * Consigne du turn qui rédige la fiche.
 *
 * Il a le droit de répondre non, et le prompt insiste : c'est ce refus qui empêche la mémoire
 * de se remplir de banalités. La conversation lui sert de contexte — il tourne dedans, avec sa
 * session, donc il a tout sous les yeux et n'a rien à relire.
 */
const EXTRACT_PROMPT = [
  "Ce turn s'est terminé après avoir rencontré au moins une erreur.",
  '',
  'Sans rien modifier, sans lancer aucune commande, réponds à une seule question : ce que tu',
  'viens de découvrir mérite-t-il d\'être retenu pour les prochains agents de ce projet ?',
  '',
  'Ne dis oui que pour ce qui a coûté cher à découvrir et qui se reproduira : un piège',
  "d'environnement, un comportement d'outil contre-intuitif, une contrainte du dépôt qui ne se",
  'devine pas en lisant le code. Une erreur de frappe corrigée, un fichier au mauvais chemin,',
  "une commande relancée avec la bonne option : non. Dans le doute, réponds non — une mémoire",
  'qui se remplit de banalités est ensuite relue à chaque turn, pour toujours.',
  '',
  'Si oui : un titre court, et une leçon de quelques phrases qui dit ce qui a été observé, ce',
  "qui l'explique, et ce qu'il faut faire à la place. Écris-la pour quelqu'un qui n'a pas suivi",
  'cette conversation.',
].join('\n');

/** Schéma de la réponse. Les trois CLIs savent contraindre leur réponse finale. */
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    worth: { type: 'boolean' },
    title: { type: 'string' },
    lesson: { type: 'string' },
  },
  required: ['worth'],
  additionalProperties: false,
};

module.exports = {
  FILE,
  STATUSES,
  MAX_TITLE,
  MAX_LESSON,
  MAX_IN_PROMPT,
  EXTRACT_PROMPT,
  EXTRACT_SCHEMA,
  worthAsking,
  list,
  get,
  pendingFor,
  propose,
  decide,
  remove,
  forget,
  slug,
  markdown,
  promptBlock,
};
