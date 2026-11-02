'use strict';

// Prompts enregistrés : les consignes qu'on retape toutes les semaines.
//
// « Relis le diff de la branche et dis-moi ce qui casse », « prépare la mise en ligne de
// <projet> », « fais le tour des dépendances ». Retapées à chaque fois, elles perdent à chaque
// fois un morceau — celui qui disait de ne PAS faire quelque chose, en général.
//
// Un modèle est un texte à trous. Les trous s'écrivent `{{nom}}`, comme partout ailleurs, et
// c'est la seule syntaxe : un langage de gabarit avec des conditions et des boucles serait un
// langage à apprendre, alors que le besoin est de remplacer trois mots.
//
// **Ce n'est pas une skill.** Une skill est une procédure que le CLI déroule lui-même, chargée
// à la demande, avec ses fichiers annexes. Un prompt enregistré n'est rien d'autre que du texte
// posé dans le composeur : on le relit et on le modifie avant d'envoyer. Les deux existent
// parce qu'ils répondent à deux questions différentes — « comment fait-on ça » et « qu'est-ce
// que je voulais dire, déjà ».

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'prompts.json');

const MAX_NAME = 80;
const MAX_BODY = 8000;
/** Au-delà, ce n'est plus un formulaire à remplir mais un questionnaire. */
const MAX_HOLES = 12;

/** `{{nom}}` — lettres, chiffres, tiret, souligné, espaces internes tolérés puis rognés. */
const HOLE = /\{\{\s*([^{}]{1,60}?)\s*\}\}/g;

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
 * Les trous d'un modèle, dans l'ordre où ils apparaissent, sans doublon.
 *
 * L'ordre du texte et non l'ordre alphabétique : le formulaire se remplit de haut en bas, et
 * il doit suivre la phrase. Un même trou répété ne demande qu'une seule fois sa valeur — c'est
 * tout l'intérêt de le nommer.
 */
function holes(body) {
  const found = [];
  const seen = new Set();
  for (const match of String(body || '').matchAll(HOLE)) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
    if (found.length === MAX_HOLES) break;
  }
  return found;
}

/**
 * Remplit les trous. Un trou sans valeur reste **tel quel**, visible dans le composeur.
 *
 * C'est la décision qui compte ici. L'effacer donnerait une phrase qui se lit bien et qui a
 * perdu un mot — « prépare la mise en ligne de » —, et un agent lancé là-dessus part sur une
 * consigne amputée sans que personne ne l'ait vu. Un `{{projet}}` resté en clair, lui, se
 * remarque au premier coup d'œil.
 */
function fill(body, values) {
  const source = values && typeof values === 'object' ? values : {};
  return String(body || '').replace(HOLE, (whole, raw) => {
    const name = raw.trim();
    const value = source[name];
    if (value === undefined || value === null || String(value).trim() === '') return whole;
    return String(value);
  });
}

function shape(row) {
  return { ...row, holes: holes(row.body) };
}

/**
 * Les modèles, du plus récemment utilisé au moins.
 *
 * Le `reverse` avant le tri règle les ex æquo : deux modèles créés dans la même milliseconde
 * portent la même date, le tri est stable, et l'ordre d'écriture ferait alors remonter le plus
 * ancien. Inverser d'abord donne la règle qu'on attend — à égalité, le plus récent gagne.
 */
function list() {
  return read()
    .reverse()
    .sort((a, b) => String(b.usedAt || b.createdAt).localeCompare(String(a.usedAt || a.createdAt)))
    .map(shape);
}

function get(id) {
  const row = read().find((r) => r.id === String(id));
  return row ? shape(row) : null;
}

function create(spec) {
  const name = clean(spec && spec.name, MAX_NAME);
  const body = clean(spec && spec.body, MAX_BODY);
  if (!name) throw new Error('Nom vide');
  if (!body) throw new Error('Consigne vide');
  const row = {
    id: crypto.randomUUID(),
    name,
    body,
    createdAt: new Date().toISOString(),
    usedAt: null,
    uses: 0,
  };
  const rows = read();
  rows.push(row);
  write(rows);
  return shape(row);
}

function update(id, patch) {
  const rows = read();
  const row = rows.find((r) => r.id === String(id));
  if (!row) return null;
  if (patch && patch.name !== undefined) {
    const name = clean(patch.name, MAX_NAME);
    if (!name) throw new Error('Nom vide');
    row.name = name;
  }
  if (patch && patch.body !== undefined) {
    const body = clean(patch.body, MAX_BODY);
    if (!body) throw new Error('Consigne vide');
    row.body = body;
  }
  write(rows);
  return shape(row);
}

function remove(id) {
  const rows = read();
  const kept = rows.filter((r) => r.id !== String(id));
  if (kept.length === rows.length) return false;
  write(kept);
  return true;
}

/**
 * Marque un modèle comme employé.
 *
 * Sert au classement, et à rien d'autre : les modèles les plus utilisés doivent être en haut
 * de la liste, sinon celle-ci devient un cimetière qu'on parcourt. Un compteur qui se trompe
 * n'a aucune conséquence — d'où l'absence totale de garde-fou ici.
 */
function used(id) {
  const rows = read();
  const row = rows.find((r) => r.id === String(id));
  if (!row) return null;
  row.uses = (row.uses || 0) + 1;
  row.usedAt = new Date().toISOString();
  write(rows);
  return shape(row);
}

module.exports = { FILE, MAX_NAME, MAX_BODY, MAX_HOLES, holes, fill, list, get, create, update, remove, used };
