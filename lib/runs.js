'use strict';

// Journal des exécutions de déclencheurs.
//
// La vue Déclencheurs ne montrait que la dernière exécution. Or la question qu'on se pose
// devant un déclencheur est rarement « comment ça s'est passé cette nuit » mais « est-ce
// que ça tourne » : trois échecs de suite ne se voient pas quand seul le dernier état est
// affiché, et un déclencheur qui n'est jamais parti ressemble à un déclencheur qui vient
// de réussir.
//
// Pourquoi un journal séparé plutôt que la liste des conversations, qui portent déjà un
// `triggerId` : les exécutions sont **purgées** après `purgeAfterDays`. Déduire
// l'historique des conversations reviendrait à effacer la trace d'un échec en même temps
// que la conversation qui l'a produit — exactement ce qu'on veut garder.
//
// Une exécution = une conversation, donc l'identifiant de conversation sert de clé. Le
// fichier est en append-only, dernière ligne gagnante pour une clé donnée : un
// enregistrement est écrit au lancement, réécrit à la fin.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const JOURNAL = path.join(DATA_DIR, 'trigger-runs.jsonl');

/**
 * Au-delà, les exécutions les plus anciennes d'un déclencheur sont oubliées à la
 * compaction. Un déclencheur horaire en produit sept cents par mois ; garder tout ferait
 * un fichier que personne ne lira jamais en entier.
 */
const MAX_PER_TRIGGER = 100;

fs.mkdirSync(DATA_DIR, { recursive: true });

/** convId -> enregistrement. Chargé à la première lecture, tenu à jour aux écritures. */
let cache = null;
let lines = 0;

function load() {
  if (cache) return cache;
  cache = new Map();
  lines = 0;
  let raw;
  try {
    raw = fs.readFileSync(JOURNAL, 'utf8');
  } catch {
    return cache;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    try {
      const run = JSON.parse(line);
      if (run && run.convId) cache.set(run.convId, run);
    } catch {
      /* ligne corrompue : on l'ignore plutôt que de perdre tout le journal */
    }
  }
  return cache;
}

function append(run) {
  fs.appendFileSync(JOURNAL, `${JSON.stringify(run)}\n`);
  lines += 1;
  load().set(run.convId, run);
  if (needsCompaction(run.triggerId)) compact();
}

/**
 * Deux raisons de réécrire le journal, et le ratio seul ne suffit pas.
 *
 * Le fichier enfle quand une même exécution est réécrite souvent — un turn qui enchaîne
 * sur des messages en attente reclôt son exécution à chaque fois. C'est ce que mesure le
 * ratio. Mais une exécution ordinaire n'est écrite que deux fois, au lancement et à la
 * clôture : ce ratio-là ne franchit jamais aucun seuil, et le plafond par déclencheur ne
 * serait jamais appliqué. D'où la seconde condition, qui est la seule à borner un
 * déclencheur horaire tournant depuis des mois.
 */
function needsCompaction(triggerId) {
  if (lines > cache.size * 3 + 50) return true;
  let count = 0;
  for (const run of cache.values()) {
    if (run.triggerId === triggerId) count += 1;
  }
  return count > MAX_PER_TRIGGER;
}

/**
 * Réécrit le journal à partir de l'état en mémoire, en bornant chaque déclencheur.
 * Déclenchée par la croissance du fichier, pas par une horloge : c'est le nombre de
 * réécritures qui fait grossir, et lui seul.
 */
function compact() {
  const perTrigger = new Map();
  for (const run of load().values()) {
    if (!perTrigger.has(run.triggerId)) perTrigger.set(run.triggerId, []);
    perTrigger.get(run.triggerId).push(run);
  }

  const kept = [];
  for (const runs of perTrigger.values()) {
    runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    kept.push(...runs.slice(-MAX_PER_TRIGGER));
  }
  kept.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  const tmp = `${JOURNAL}.tmp`;
  fs.writeFileSync(tmp, kept.map((run) => `${JSON.stringify(run)}\n`).join(''));
  fs.renameSync(tmp, JOURNAL);

  cache = new Map(kept.map((run) => [run.convId, run]));
  lines = kept.length;
}

/**
 * Ouvre une exécution. Écrite dès le lancement et non à la fin : une exécution qui ne
 * revient jamais — processus tué, serveur redémarré — doit laisser une trace, sinon elle
 * disparaît de l'historique et le déclencheur passe pour n'avoir rien fait.
 */
function start({ convId, triggerId, title, startedAt }) {
  const run = {
    convId,
    triggerId,
    title: title || null,
    startedAt: startedAt || new Date().toISOString(),
    endedAt: null,
    status: 'working',
    durationMs: null,
    costUsd: 0,
    error: null,
  };
  append(run);
  return run;
}

/**
 * Clôt une exécution. Appelée à chaque fin de turn : une exécution qui enchaîne sur un
 * message en attente est donc mise à jour plusieurs fois, et sa durée court du lancement
 * au dernier turn — ce qui est bien le temps qu'elle a pris.
 *
 * @returns {object|null} l'enregistrement à jour, ou null si l'exécution est inconnue
 */
function finish(convId, { status, costUsd, error } = {}) {
  const current = load().get(convId);
  if (!current) return null;
  const endedAt = new Date().toISOString();
  const started = Date.parse(current.startedAt);
  const run = {
    ...current,
    endedAt,
    status: status || 'done',
    durationMs: Number.isNaN(started) ? null : Date.parse(endedAt) - started,
    costUsd: costUsd || current.costUsd || 0,
    error: error || null,
  };
  append(run);
  return run;
}

/**
 * Attache le rapport à une exécution déjà close.
 *
 * Le rapport arrive après la clôture, puisqu'il est rédigé par un turn qui suit. Il est
 * gardé ici plutôt que seulement dans le fil : c'est ce qui permet de le relire depuis
 * l'historique une fois la conversation purgée, comme le reste de la ligne.
 */
function attachReport(convId, written) {
  const current = load().get(convId);
  if (!current || !written) return null;
  const run = { ...current, report: written };
  append(run);
  return run;
}

/** Exécutions d'un déclencheur, la plus récente d'abord. */
function forTrigger(triggerId, limit) {
  const runs = [...load().values()].filter((run) => run.triggerId === triggerId);
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return limit ? runs.slice(0, limit) : runs;
}

/** Exécutions jamais closes. Au démarrage, ce sont celles qu'un arrêt a coupées. */
function open() {
  return [...load().values()].filter((run) => run.status === 'working');
}

/** Oublie les exécutions d'un déclencheur supprimé : sans ça le journal ne décroît jamais. */
function forget(triggerId) {
  const before = load().size;
  for (const [convId, run] of cache) {
    if (run.triggerId === triggerId) cache.delete(convId);
  }
  if (cache.size !== before) compact();
  return before - cache.size;
}

module.exports = {
  start,
  finish,
  attachReport,
  forTrigger,
  open,
  forget,
  JOURNAL,
  MAX_PER_TRIGGER,
};
