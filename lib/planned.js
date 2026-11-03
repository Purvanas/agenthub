'use strict';

// Messages planifiés : « envoie ça à 18 h, dans cette conversation ».
//
// Le besoin auquel ça répond : un contexte est déjà construit — le ticket est lu, la branche
// est identifiée, l'agent sait de quoi on parle — et on veut que l'action parte plus tard
// sans avoir à réécrire tout ça, ni risquer de se tromper de branche en le retapant à 18 h.
//
// Pourquoi un module à part et pas un déclencheur `once` : un déclencheur crée une
// conversation neuve à chaque exécution, ce qui est exactement ce qu'on ne veut pas ici. Il
// porte aussi un nom, un dossier, une purge, un rapport — du bruit pour un message qui part
// une fois. Ce qu'on réutilise du côté des déclencheurs, c'est la seule chose qui compte :
// la boucle du planificateur, qui sait déjà quand agir.
//
// Trois modes, et c'est le dernier qu'on veut la plupart du temps :
//
//   'same'   — le message part dans la conversation elle-même. Simple, mais il faut la laisser
//              tranquille jusque-là, sinon il arrive après tout ce qu'on a dit entre-temps.
//   'frozen' — la conversation enfant est créée **à la planification**, sur une copie de la
//              session prise à cet instant. Le contexte est celui de maintenant, le fil parent
//              repart librement, et à l'échéance il n'y a plus qu'à envoyer le message.
//   'fork'   — repli quand le fournisseur ne sait pas geler : l'enfant est dérivé à l'échéance
//              et hérite donc du parent tel qu'il est devenu. Isolé, mais pas figé.
//
// Une erreur à ne pas refaire : `fork` a longtemps été le seul mode « à côté », au motif que
// geler demanderait de matérialiser le fork tout de suite, donc de dépenser un turn. C'était
// faux. Une session Claude est un fichier, `--resume` accepte une copie nue, et copier un
// fichier ne coûte pas de turn — voir lib/sessions.js pour la mesure.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'planned.json');

// `frozen` n'est pas un choix de l'utilisateur mais le résultat du sien : quand il demande
// « dans une copie » et que le fournisseur sait geler sa session, la copie est faite tout de
// suite et le message vise directement la conversation enfant. `fork` reste le repli, où la
// dérivation a lieu à l'échéance et isole donc sans figer.
const MODES = ['same', 'fork', 'frozen'];

/** Au-delà, la consigne n'est plus un message mais un document. */
const MAX_PROMPT = 20_000;

/**
 * Les messages partis restent listés un moment : voir « c'est bien parti à 18 h » est la
 * moitié de l'intérêt. Au-delà, ils encombrent.
 */
const KEEP_DONE_MS = 7 * 86_400_000;

// Envois dont le planificateur a pris possession dans ce processus. La persistance reste
// `pending` jusqu'au vrai départ pour conserver la reprise après crash ; ce verrou mémoire
// ferme la course avec un second tick et, surtout, avec le bouton Annuler pendant l'instantané
// asynchrone qui précède le turn.
const sending = new Set();

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

/**
 * Valide et enregistre un message planifié.
 * @returns {{error: string}|{planned: object}}
 */
function add({ convId, prompt, runAt, mode, ownsConv, frozenSession, fromConvId }) {
  if (!convId) return { error: 'Conversation inconnue' };

  const text = String(prompt || '').trim().slice(0, MAX_PROMPT);
  if (!text) return { error: 'Message vide' };

  const at = new Date(runAt);
  if (Number.isNaN(at.getTime())) return { error: `Date et heure illisibles : ${runAt}` };
  // Une échéance passée partirait au tick suivant, donc maintenant. Ce n'est jamais ce qu'on
  // voulait en tapant une heure, et un agent qui démarre par surprise est le pire des cas.
  if (at.getTime() <= Date.now()) {
    return { error: 'Cette date est déjà passée : choisis un moment à venir.' };
  }

  const how = MODES.includes(mode) ? mode : 'fork';

  const planned = {
    id: crypto.randomUUID(),
    convId,
    prompt: text,
    runAt: at.toISOString(),
    mode: how,
    status: 'pending',
    createdAt: new Date().toISOString(),
    // La conversation visée a-t-elle été créée pour ce message ? Si oui, l'annuler doit
    // l'emporter — sinon une copie gelée vide traînerait dans la sidebar pour toujours.
    ownsConv: Boolean(ownsConv),
    // Session copiée à la planification, à effacer avec le message s'il est annulé.
    frozenSession: frozenSession || null,
    // Conversation d'origine, quand la cible est une copie : c'est ce qui permet de dire
    // « copie gelée de X » plutôt que d'afficher un fil orphelin.
    fromConvId: fromConvId || null,
    sentAt: null,
    // Conversation où le message a réellement été envoyé : la même, ou l'enfant créé pour
    // l'occasion. C'est ce qui rend le résultat consultable après coup.
    ranIn: null,
    error: null,
  };

  const list = readAll();
  list.push(planned);
  writeAll(list);
  return { planned };
}

/** Messages dont l'échéance est atteinte et qui n'ont pas encore été envoyés. */
function due(now = new Date()) {
  return readAll().filter(
    (p) => p.status === 'pending' && new Date(p.runAt).getTime() <= now.getTime()
  );
}

/**
 * Prend possession d'un message arrivé à échéance.
 *
 * La prise est volontairement en mémoire : si le processus tombe avant `sent`/`failed`, le
 * message reste récupérable au redémarrage au lieu d'être figé dans un statut intermédiaire.
 */
function claim(id, now = new Date()) {
  const key = String(id);
  if (sending.has(key)) return null;
  const row = readAll().find(
    (p) =>
      p.id === key &&
      p.status === 'pending' &&
      new Date(p.runAt).getTime() <= now.getTime()
  );
  if (!row) return null;
  sending.add(key);
  return row;
}

/** Ceux qui attendent encore, pour une conversation ou pour toutes. */
function pending(convId) {
  return readAll()
    .filter((p) => p.status === 'pending' && (!convId || p.convId === convId))
    .sort((a, b) => a.runAt.localeCompare(b.runAt));
}

/** Tout ce qui est connu d'une conversation, en attente comme déjà parti. */
function forConversation(convId) {
  return readAll()
    .filter((p) => p.convId === convId)
    .sort((a, b) => b.runAt.localeCompare(a.runAt));
}

/** Tout, le plus proche d'abord — pour la vue Planifier. */
function all() {
  return readAll().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    return a.status === 'pending' ? a.runAt.localeCompare(b.runAt) : b.runAt.localeCompare(a.runAt);
  });
}

function finish(id, patch) {
  const list = readAll();
  const found = list.find((p) => p.id === id && p.status === 'pending');
  if (!found) return null;
  Object.assign(found, patch);
  writeAll(list);
  return found;
}

/** Marque un message comme parti, en notant où. */
function sent(id, ranIn) {
  try {
    return finish(id, { status: 'sent', sentAt: new Date().toISOString(), ranIn: ranIn || null });
  } finally {
    sending.delete(String(id));
  }
}

/**
 * Marque un message comme impossible à envoyer, avec la raison.
 *
 * Le statut est final : réessayer à chaque tick enverrait le même message toutes les trente
 * secondes le jour où sa conversation a disparu.
 */
function failed(id, reason) {
  try {
    return finish(id, {
      status: 'failed',
      sentAt: new Date().toISOString(),
      error: String(reason || '').slice(0, 300),
    });
  } finally {
    sending.delete(String(id));
  }
}

/**
 * Annulation par l'utilisateur.
 *
 * Renvoie l'enregistrement retiré, et non un booléen : l'appelant a besoin de savoir s'il
 * doit aussi supprimer la conversation créée pour lui et la session gelée.
 *
 * @returns {object|null}
 */
function cancel(id) {
  if (sending.has(String(id))) return null;
  const list = readAll();
  const found = list.find((p) => p.id === id && p.status === 'pending');
  if (!found) return null;
  writeAll(list.filter((p) => p !== found));
  return found;
}

/**
 * Retire ce qui concerne une conversation supprimée, et les vieux messages déjà partis.
 * Appelée par le planificateur : sans elle le fichier ne décroît jamais.
 *
 * @param {(id: string) => boolean} exists
 */
function sweep(exists, now = new Date()) {
  const list = readAll();
  const kept = list.filter((p) => {
    // Un autre tick peut balayer pendant que l'envoi asynchrone est en cours. Son résultat
    // (`sent` ou `failed`) doit rester inscriptible, même si la conversation vient de
    // disparaître entre-temps.
    if (sending.has(String(p.id))) return true;
    if (!exists(p.convId)) return false;
    if (p.status === 'pending') return true;
    const at = new Date(p.sentAt || p.runAt).getTime();
    return now.getTime() - at < KEEP_DONE_MS;
  });
  if (kept.length !== list.length) writeAll(kept);
  return list.length - kept.length;
}

module.exports = {
  add,
  due,
  claim,
  pending,
  forConversation,
  all,
  sent,
  failed,
  cancel,
  sweep,
  MODES,
  MAX_PROMPT,
  KEEP_DONE_MS,
  FILE,
};
