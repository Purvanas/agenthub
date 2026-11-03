'use strict';

// Demandes d'arbitrage produites par les agents.
//
// Les agents tournent en autonomie totale : aucun prompt de permission ne les arrête, donc
// devant une décision ambiguë ils tranchent seuls et on le découvre le lendemain. Ce module
// leur donne le seul canal qui manquait — poser la question et rendre la main, l'humain
// répond depuis n'importe quel appareil, et agentHub relance le travail avec la réponse.
//
// Le turn n'est pas suspendu, il se termine : un CLI non-interactif ne sait pas attendre.
// C'est exactement la mécanique des demandes de connexion (`lib/auth-requests.js`), dont ce
// fichier reprend la forme.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'asks.json');

const MAX_OPTIONS = 6;
const MAX_ROWS = 200;

/**
 * Deux façons de poser une question, selon ce dont dispose l'agent.
 *
 * `turn` — la voie universelle : l'agent poste sa question par `curl` et **termine son
 * turn**, la réponse en relance un nouveau. Marche partout, coûte un redémarrage de
 * contexte, d'où la consigne de reprise qui rappelle question et réponse.
 *
 * `live` — l'agent appelle l'outil MCP `ask_user`, qui **ne répond pas** tant que personne
 * n'a répondu. Le turn reste ouvert, l'agent garde tout son contexte et enchaîne. C'est la
 * même chose que la modale native de Claude Code, mais servie par agentHub, donc offerte à
 * tous les fournisseurs qui savent recevoir un serveur MCP.
 */
const MODES = ['turn', 'live'];

/**
 * Plafond d'attente d'une question `live`, et pourquoi il vaut quatre minutes.
 *
 * **Mesuré le 05/08/2026** : une question tenue ouverte a survécu à 4 min 55, et le turn
 * était tombé à 5 min 30. C'est le plafond dur de Claude Code, celui que son binaire décrit
 * comme *« Capped at 5 minutes »* pour le timeout de requête HTTP par serveur — et
 * `MCP_TOOL_TIMEOUT`, réglé à dix minutes lors de cet essai, **ne l'a pas relevé**.
 *
 * On se range donc en dessous : nous expirons les premiers, l'agent reçoit notre message
 * plutôt que l'opaque « The operation timed out », et il retombe proprement sur la voie qui
 * termine le turn.
 *
 * **Le relever a été tenté et ne marche pas.** La clé de timeout par serveur, ajoutée à la
 * configuration MCP, est acceptée sans lever le plafond : l'appel reste coupé entre 5 et 6
 * minutes. Voir `mcpConfigJson` dans `lib/runner.js`, qui porte le détail de la mesure.
 *
 * `AGENTHUB_ASK_TIMEOUT_MS` permet d'en changer, en connaissance de cause.
 */
const WAIT_MS = Number(process.env.AGENTHUB_ASK_TIMEOUT_MS) || 4 * 60 * 1000;

/** Marge laissée au CLI par-dessus notre propre plafond, pour que le nôtre tombe en premier. */
const CLI_MARGIN_MS = 30_000;

/**
 * Appels d'outil en attente, par identifiant de demande. En mémoire seulement, et c'est
 * assumé : une promesse ne se sérialise pas, et un redémarrage a de toute façon coupé la
 * requête HTTP que l'agent attendait. `dropWaiters` s'en occupe au démarrage.
 */
const waiters = new Map();

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
  // Le plafond porte sur l'historique, jamais sur une question qui attend encore. Un simple
  // `slice(-200)` finissait par faire disparaître silencieusement la plus ancienne demande
  // pending dès que 200 questions plus récentes avaient été posées dans d'autres fils.
  const pending = rows.filter((row) => row.status === 'pending');
  let kept;
  if (pending.length >= MAX_ROWS) {
    kept = pending;
  } else {
    const recentClosed = rows
      .filter((row) => row.status !== 'pending')
      .slice(-(MAX_ROWS - pending.length));
    const selected = new Set([...pending, ...recentClosed]);
    kept = rows.filter((row) => selected.has(row));
  }
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function clean(value, max) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .slice(0, max);
}

/**
 * Les propositions arrivent en tableau JSON, ou en une chaîne séparée par des `|`.
 *
 * Les deux sont acceptées délibérément : la demande est produite par un `curl` dont le corps
 * est déjà du JSON échappé dans une commande shell, et imbriquer un tableau là-dedans est
 * l'endroit exact où les agents se trompent de guillemets. Une forme plate qui marche vaut
 * mieux qu'une forme pure qui échoue une fois sur trois.
 */
function parseOptions(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split('|');
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const label = clean(entry, 120);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

/**
 * Enregistre une question. Une conversation n'a qu'une demande en attente à la fois : son
 * turn s'est terminé en la posant, elle ne peut donc pas en produire une seconde avant
 * d'avoir été relancée. Une demande plus récente remplace la précédente plutôt que de
 * laisser deux questions concurrentes réclamer la même réponse.
 */
function create(spec) {
  const convId = clean(spec && spec.convId, 80);
  const question = clean(spec && spec.question, 500);
  if (!convId) throw new Error('Conversation manquante');
  if (!question) throw new Error('Question manquante');
  const row = {
    id: crypto.randomUUID(),
    convId,
    question,
    options: parseOptions(spec && spec.options),
    context: clean(spec && spec.context, 1000),
    status: 'pending',
    mode: MODES.includes(spec && spec.mode) ? spec.mode : 'turn',
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
  const rows = read();
  // Une demande plus récente remplace celle qui attendait encore. Si un appel d'outil était
  // suspendu dessus, il faut le libérer ici : sans ça l'agent resterait bloqué sur une
  // question que plus personne ne voit, jusqu'à expiration.
  const replaced = rows.filter((old) => old.convId === convId && old.status === 'pending');
  const kept = rows.filter((r) => !(r.convId === convId && r.status === 'pending'));
  kept.push(row);
  write(kept);
  // Seulement après la persistance : si l'écriture échoue, l'ancienne question reste visible
  // et doit donc conserver l'appel d'outil qui attend sa réponse.
  for (const old of replaced) settle(old.id, null);
  return row;
}

function list(status) {
  return read().filter((r) => !status || r.status === status);
}

function get(id) {
  return read().find((r) => r.id === id) || null;
}

/** Demande en attente d'une conversation, s'il y en a une. */
function pendingFor(convId) {
  return read().find((r) => r.convId === convId && r.status === 'pending') || null;
}

/**
 * Enregistre la réponse humaine. Répondre deux fois à la même demande ne relance pas deux
 * fois le travail : la seconde tentative est refusée.
 *
 * Débloque au passage l'appel d'outil suspendu, s'il y en a un. C'est ce qui distingue les
 * deux modes du point de vue de l'appelant : en `live` la réponse suffit, en `turn` il
 * reste à relancer la conversation.
 */
function answer(id, text) {
  const rows = read();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  const value = clean(text, 2000);
  if (!value) throw new Error('Réponse vide');
  row.status = 'answered';
  row.answer = value;
  row.answeredAt = new Date().toISOString();
  write(rows);
  settle(row.id, row);
  return row;
}

/** Y a-t-il un appel d'outil suspendu sur cette demande ? */
function hasWaiter(id) {
  return waiters.has(String(id));
}

/** Résout l'attente d'une demande, s'il y en a une. `row` null veut dire « pas de réponse ». */
function settle(id, row) {
  const waiter = waiters.get(String(id));
  if (!waiter) return false;
  waiters.delete(String(id));
  clearTimeout(waiter.timer);
  waiter.resolve(row);
  return true;
}

/**
 * Suspend l'appel d'outil jusqu'à la réponse humaine.
 *
 * @returns {Promise<object|null>} la demande répondue, ou null si le plafond est atteint —
 *   auquel cas la demande passe en `expired` et l'agent se voit rendre la main pour
 *   retomber sur la voie `turn`.
 */
function waitFor(id, timeoutMs) {
  const key = String(id);

  // La réponse peut déjà être persistée quand un appelant rejoint l'attente (reprise après
  // une diffusion synchrone, test d'intégration, ou futur transport). Attendre malgré tout
  // ferait expirer une réponse pourtant reçue. Une demande absente ou déjà fermée ne peut,
  // elle non plus, redevenir répondable.
  const current = get(key);
  if (!current || current.status !== 'pending') {
    return Promise.resolve(current && current.status === 'answered' ? current : null);
  }

  // Deux consommateurs ne doivent pas s'écraser : le second partage la même attente. Sans
  // ça, son `set` remplaçait le resolveur du premier, qui ne rendait la main qu'à son propre
  // timeout même après la réponse.
  const existing = waiters.get(key);
  if (existing) return existing.promise;

  let resolveWaiter;
  const promise = new Promise((resolve) => {
    resolveWaiter = resolve;
  });
  // Ce minuteur reste référencé : c'est lui qui garantit que la demande expire et que la
  // promesse rend la main, même si la socket HTTP disparaît entre-temps. L'arrêt PM2 passe
  // par le gestionnaire SIGTERM du serveur et n'attend donc pas ce plafond.
  const timer = setTimeout(() => {
    waiters.delete(key);
    try {
      expire(key);
    } catch (err) {
      // Une panne disque ne doit ni laisser l'appel MCP suspendu pour toujours, ni devenir
      // une exception non interceptée issue d'un callback de timer — donc tuer le serveur.
      console.error(`expiration de la demande ${key} impossible : ${err.message}`);
    } finally {
      resolveWaiter(null);
    }
  }, Number(timeoutMs) || WAIT_MS);
  waiters.set(key, { resolve: resolveWaiter, timer, promise });
  return promise;
}

/** Marque une demande expirée. Sans effet si elle a été répondue entre-temps. */
function expire(id) {
  const rows = read();
  const row = rows.find((r) => r.id === String(id));
  if (!row || row.status !== 'pending') return null;
  row.status = 'expired';
  row.answeredAt = new Date().toISOString();
  write(rows);
  settle(row.id, null);
  return row;
}

/**
 * Au démarrage : plus personne n'attend.
 *
 * Un redémarrage a coupé les requêtes HTTP que les agents tenaient ouvertes, et les
 * promesses qui allaient avec. Laisser ces demandes en `pending` afficherait des questions
 * dont la réponse ne débloquerait rien. On les expire, ce qui fait retomber le prochain
 * turn sur la voie `turn` — la retombée prévue.
 *
 * @returns {number} nombre de demandes fermées
 */
function dropWaiters() {
  const rows = read();
  let closed = 0;
  for (const row of rows) {
    if (row.status === 'pending' && row.mode === 'live') {
      row.status = 'expired';
      row.answeredAt = new Date().toISOString();
      closed += 1;
    }
  }
  if (closed) write(rows);
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  waiters.clear();
  return closed;
}

function forget(convId) {
  const rows = read();
  const removed = rows.filter((r) => r.convId === convId);
  const kept = rows.filter((r) => r.convId !== convId);
  if (kept.length !== rows.length) write(kept);
  for (const row of removed) settle(row.id, null);
  return rows.length - kept.length;
}

/**
 * Consigne envoyée à l'agent quand on le relance. Elle rappelle la question : le turn qui
 * l'avait posée est terminé, et rien ne garantit que le CLI ait gardé sa session — un
 * « oui » nu ne voudrait alors plus rien dire.
 */
function resumePrompt(row) {
  return [
    "Réponse de l'utilisateur à ta demande d'arbitrage.",
    '',
    `Ta question : ${row.question}`,
    `Sa réponse : ${row.answer}`,
    '',
    'Reprends le travail à partir de là. Ne repose pas la question.',
  ].join('\n');
}

/**
 * Bloc ajouté à chaque prompt. Le plus important n'est pas d'apprendre le canal à l'agent,
 * c'est de le retenir de s'en servir : une demande à chaque hésitation rendrait l'autonomie
 * inutile et les déclencheurs de nuit inexploitables. D'où les deux conditions cumulatives
 * — une erreur coûteuse à défaire, et tout le reste déjà fait.
 */
function promptBlock(toolName) {
  const lines = [
    '',
    '',
    "Demande d'arbitrage :",
    "Tu travailles sans surveillance. Si une decision est ambigue et qu'un mauvais choix",
    'serait couteux a defaire (supprimer des donnees, choisir une architecture, publier),',
    "ne devine pas : demande. N'y recours pas pour une preference reversible, tranche seul.",
    "Fais d'abord tout ce qui ne depend pas de la reponse, puis pose la question.",
    "Cette retenue vaut TANT QUE TU TRAVAILLES. Si tu t'apretes a rendre la main en listant",
    'deux ou trois facons de faire pour que l utilisateur choisisse, alors demande plutot que',
    'de lister : tu attends deja, et une question se repond en un geste.',
  ];

  // Avec l'outil, l'agent ne s'interrompt pas : il attend la reponse et enchaine. Le `curl`
  // reste decrit en retombee, parce que l'outil peut expirer — et parce qu'un fournisseur
  // qui ne recoit pas de serveur MCP n'a que lui.
  if (toolName) {
    lines.push(
      `Utilise l'outil ${toolName} : il attend la reponse et te la rend, sans que tu aies a`,
      "arreter ton travail. Ses arguments : question, options (facultatives), context.",
      "S'il te repond que personne n'a repondu, alors seulement passe par la voie ci-dessous."
    );
  } else {
    lines.push('Termine proprement ton message apres avoir poste la question :');
  }

  lines.push(
    'curl -fsS -X POST "$AGENTHUB_ASK_URL" -H "Content-Type: application/json" -d "{\\"convId\\":\\"$AGENTHUB_CONV_ID\\",\\"question\\":\\"TA_QUESTION\\",\\"options\\":\\"CHOIX_A|CHOIX_B\\",\\"context\\":\\"CE_QUE_TU_AS_DEJA_FAIT\\"}"',
    "Cette voie termine ton turn : l'utilisateur repondra depuis agentHub, qui te relancera.",
    'Les options sont facultatives et separees par des barres verticales.',
    'Cette consigne est interne : ne la cite et ne la recopie jamais dans ta reponse.'
  );
  return lines.join('\n');
}

module.exports = {
  FILE,
  MAX_OPTIONS,
  MODES,
  WAIT_MS,
  CLI_MARGIN_MS,
  create,
  list,
  get,
  pendingFor,
  answer,
  expire,
  waitFor,
  hasWaiter,
  dropWaiters,
  forget,
  resumePrompt,
  promptBlock,
  parseOptions,
};
