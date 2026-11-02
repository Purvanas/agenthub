'use strict';

// Geler une session : en faire une copie qui n'évoluera plus.
//
// Sert à la planification d'un message « dans une copie ». Sans ça, la copie était faite à
// l'échéance et héritait donc du parent tel qu'il était à 18 h — isolé, mais pas figé. Or ce
// qu'on veut est l'inverse : le contexte de **maintenant**, au moment où on a tout en tête,
// et un fil parent qu'on peut continuer à utiliser librement.
//
// Ce que ça n'est pas : un `--fork-session`. Celui-là copie la session au moment où la
// commande tourne, ce qui demanderait de dépenser un turn à la planification pour figer quoi
// que ce soit. Ici on copie le **fichier de session** sur disque, et on le reprend plus tard
// avec `--resume`. Aucun turn dépensé, gel exact.
//
// Mesuré le 03/08/2026 : on fait retenir 111, on copie, on fait remplacer par 999 dans
// l'originale, on interroge la copie. Elle répond 111, l'originale 999. Et `--resume` accepte
// une copie nue, sans aucun enregistrement ailleurs.
//
// Ne marche que pour Claude, et c'est assumé. Une session Claude est **un fichier**
// `<uuid>.jsonl`. Une session Grok est un **dossier** de plusieurs fichiers, avec un verrou :
// le copier à l'aveugle serait un pari, et un pari perdu donnerait un contexte non gelé en
// prétendant l'avoir gelé — pire que de dire non. Codex ne sait de toute façon pas dériver.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** Racine des sessions Claude Code, un sous-dossier par dossier de travail. */
function claudeRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Fichier d'une session Claude, cherché et non calculé.
 *
 * Le nom du sous-dossier est le chemin de travail transformé (`/tmp/fz` devient `-tmp-fz`),
 * mais la règle exacte pour les autres caractères n'est pas documentée. L'identifiant de
 * session étant un UUID, le chercher dans tous les sous-dossiers est à la fois plus court et
 * plus sûr que de reproduire une transformation qu'on ne connaît pas.
 */
function findClaude(sessionId) {
  const root = claudeRoot();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Les fournisseurs dont on sait geler une session, et rien de plus. */
const FREEZABLE = new Set(['claude']);

function supports(provider) {
  return FREEZABLE.has(provider);
}

/**
 * Copie une session sous un nouvel identifiant.
 *
 * @param {string} provider
 * @param {string} sessionId session à figer
 * @returns {{sessionId: string, file: string}|null} null si le gel n'est pas possible —
 *   fournisseur non pris en charge, ou session pas encore écrite sur disque
 */
function freeze(provider, sessionId) {
  if (!supports(provider) || !sessionId) return null;

  const source = findClaude(sessionId);
  if (!source) return null;

  const frozen = crypto.randomUUID();
  const target = path.join(path.dirname(source), `${frozen}.jsonl`);
  try {
    // Dans le même dossier que l'originale : c'est le dossier de travail qui le détermine,
    // et la copie s'utilisera dans le même.
    fs.copyFileSync(source, target);
  } catch {
    return null;
  }
  return { sessionId: frozen, file: target };
}

/**
 * Supprime une session gelée devenue inutile — un envoi planifié annulé avant d'avoir servi.
 * Sans ça, chaque annulation laisserait une copie de session sur disque.
 */
function forget(provider, sessionId) {
  if (!supports(provider) || !sessionId) return false;
  const file = findClaude(sessionId);
  if (!file) return false;
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = { freeze, forget, supports, findClaude, FREEZABLE };
