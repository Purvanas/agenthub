'use strict';

// Réglages modifiables depuis l'interface, superposés aux fichiers de `config/`.
//
// Pourquoi une couche au lieu d'écrire directement dans `config/` : **ce dossier est suivi
// par git**, et le déploiement repose sur `receive.denyCurrentBranch=updateInstead`, qui
// refuse un push si la copie de travail est sale. Une page de réglages qui écrirait dans
// `config/notify.json` casserait donc le `git push` depuis le PC, avec un message de git qui
// ne dirait pas pourquoi. Les modifications vont dans `data/settings.json`, hors du dépôt,
// et `config/*.json` reste la couche de valeurs par défaut — celle qu'un clone reçoit, et
// celle qu'on met à jour en versionnant.
//
// Second effet, aussi important : les fichiers de `config/` sont **à moitié de la
// documentation**. Leurs clés `_doc` portent ce qui a été vérifié, quand, et pourquoi tel
// réglage est ce qu'il est. Un formulaire qui réécrirait le fichier les effacerait à la
// première sauvegarde. Ici on ne touche jamais au fichier d'origine.
//
// Ce qui n'est PAS réglable ici, et volontairement : `pricing.json` et `models.json`. Ce ne
// sont pas des préférences mais des **relevés** — des observations de sortie de CLI, datées,
// avec la mention de ce qui n'a pas pu être vérifié. Un prix faux saisi dans un champ ne se
// remarque jamais, alors qu'un prix faux dans un diff se relit.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = process.env.AGENTHUB_SETTINGS || path.join(DATA_DIR, 'settings.json');
const CONFIG_DIR = path.join(__dirname, '..', 'config');

/**
 * Champ dont la valeur ne doit jamais repartir vers le navigateur.
 *
 * Le mot de passe SMTP en est un. L'interface reçoit `passSet: true/false` à la place, et
 * une valeur vide à l'enregistrement veut dire « inchangé » — sans ça, ouvrir la page et
 * cliquer sur Enregistrer effacerait le mot de passe.
 */
const SECRET = 'secret';

/**
 * Les sections, et pour chacune le fichier de défauts et les champs autorisés.
 *
 * La liste des champs n'est pas de la décoration : elle borne ce qu'un POST peut écrire. Sans
 * elle, la page de réglages serait un moyen d'injecter n'importe quelle clé dans le fichier
 * qui pilote les notifications sortantes. Tout ce qui n'y figure pas reste hérité de
 * `config/` — les en-têtes d'authentification de `notify.json`, par exemple, qui restent
 * réservés au fichier.
 */
const SECTIONS = {
  notify: {
    file: 'notify.json',
    env: 'AGENTHUB_NOTIFY_CONFIG',
    fields: {
      enabled: { type: 'bool' },
      format: { type: 'enum', values: ['ntfy', 'json'] },
      url: { type: 'text' },
      topic: { type: 'text' },
      appUrl: { type: 'text' },
      events: { type: 'set', values: ['done', 'error', 'stopped'] },
    },
  },
  mail: {
    file: 'mail.json',
    env: 'AGENTHUB_MAIL_CONFIG',
    fields: {
      enabled: { type: 'bool' },
      host: { type: 'text' },
      port: { type: 'port' },
      secure: { type: 'bool' },
      user: { type: 'text' },
      pass: { type: SECRET },
      from: { type: 'text' },
      to: { type: 'text' },
    },
  },
  browser: {
    file: 'browser.json',
    fields: {
      enabled: { type: 'bool' },
      url: { type: 'text' },
      name: { type: 'text' },
      grokGlobal: { type: 'bool' },
    },
  },
  memory: {
    file: 'memory.json',
    fields: {
      enabled: { type: 'bool' },
      writeFile: { type: 'bool' },
    },
  },
  groups: {
    file: 'groups.json',
    fields: {
      newFolderParents: { type: 'lines' },
      exclude: { type: 'lines' },
      groups: { type: 'groups' },
    },
  },
};

const NAMES = Object.keys(SECTIONS);

// --- Lecture ------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultsFile(name) {
  const spec = SECTIONS[name];
  return (spec.env && process.env[spec.env]) || path.join(CONFIG_DIR, spec.file);
}

/** Tout le fichier de surcharges. */
function overrides() {
  return readJson(FILE, {});
}

/**
 * Superpose la surcharge sur les défauts, champ par champ et non par fusion profonde.
 *
 * Les tableaux se REMPLACENT : une liste d'exclusions dont on retire une ligne doit
 * effectivement la perdre. Une fusion de tableaux rendrait toute suppression impossible,
 * et c'est le genre de bug qu'on met une heure à voir.
 */
function merge(defaults, override, fields) {
  const out = { ...defaults };
  if (!override || typeof override !== 'object') return out;
  for (const key of Object.keys(fields)) {
    if (Object.prototype.hasOwnProperty.call(override, key)) out[key] = override[key];
  }
  return out;
}

/**
 * Réglages effectifs d'une section : ce que le code doit lire. Les clés `_doc` des fichiers
 * de `config/` traversent telles quelles — elles ne gênent personne et disparaîtraient
 * sinon des lectures qui reprennent l'objet entier.
 */
function read(name) {
  const spec = SECTIONS[name];
  if (!spec) throw new Error(`section de réglages inconnue : ${name}`);
  return merge(readJson(defaultsFile(name), {}), overrides()[name], spec.fields);
}

// --- Validation ---------------------------------------------------------------------

function asText(value) {
  return String(value == null ? '' : value).trim();
}

/** Une ligne par entrée, les vides jetées : c'est ce que rend un `<textarea>`. */
function asLines(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split('\n');
  return list.map((l) => asText(l)).filter(Boolean);
}

function coerce(key, field, value) {
  switch (field.type) {
    case 'bool':
      return Boolean(value);

    case 'port': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${key} : port invalide`);
      }
      return port;
    }

    case 'enum':
      if (!field.values.includes(value)) {
        throw new Error(`${key} : attendu ${field.values.join(' ou ')}`);
      }
      return value;

    case 'set': {
      const list = Array.isArray(value) ? value : [];
      // Filtré plutôt que refusé : l'interface n'envoie que des cases connues, et un
      // événement inconnu qui traînerait ne doit pas empêcher d'enregistrer le reste.
      return field.values.filter((v) => list.includes(v));
    }

    case 'lines':
      return asLines(value);

    case 'groups': {
      if (!Array.isArray(value)) throw new Error(`${key} : liste attendue`);
      return value
        .map((g) => ({ label: asText(g && g.label), patterns: asLines(g && g.patterns) }))
        // Un groupe sans nom ou sans motif ne classe rien : le garder ferait une ligne
        // vide dans le sélecteur de dossier, sans qu'on comprenne d'où elle vient.
        .filter((g) => g.label && g.patterns.length);
    }

    case SECRET:
    case 'text':
    default:
      return asText(value);
  }
}

/**
 * Nettoie un envoi de formulaire. Renvoie seulement les champs présents : ce qui n'est pas
 * envoyé n'est pas touché, et une valeur vide sur un champ secret veut dire « inchangé ».
 */
function clean(name, patch) {
  const spec = SECTIONS[name];
  if (!spec) throw new Error(`section de réglages inconnue : ${name}`);
  if (!patch || typeof patch !== 'object') throw new Error('réglages attendus');

  const out = {};
  for (const [key, field] of Object.entries(spec.fields)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = coerce(key, field, patch[key]);
    if (field.type === SECRET && value === '') continue;
    out[key] = value;
  }
  return out;
}

// --- Écriture ------------------------------------------------------------------------

function writeFile(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  // 0600 : le fichier porte le mot de passe SMTP.
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/**
 * Enregistre une section et renvoie ses réglages effectifs.
 *
 * Une surcharge égale au défaut est retirée plutôt qu'écrite : `data/settings.json` ne
 * contient ainsi que ce qui s'écarte vraiment du dépôt, et une valeur par défaut corrigée
 * par un `git pull` prend effet au lieu d'être masquée par une surcharge devenue inutile.
 */
function save(name, patch) {
  const spec = SECTIONS[name];
  if (!spec) throw new Error(`section de réglages inconnue : ${name}`);

  const patched = clean(name, patch);
  const defaults = readJson(defaultsFile(name), {});
  const all = overrides();
  const next = { ...(all[name] || {}), ...patched };

  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) === JSON.stringify(defaults[key])) delete next[key];
  }

  if (Object.keys(next).length) all[name] = next;
  else delete all[name];

  writeFile(all);
  return read(name);
}

/** Remet une section à ses valeurs de dépôt : la surcharge disparaît. */
function reset(name) {
  if (!SECTIONS[name]) throw new Error(`section de réglages inconnue : ${name}`);
  const all = overrides();
  delete all[name];
  writeFile(all);
  return read(name);
}

// --- Pour l'interface -----------------------------------------------------------------

/**
 * Ce que la page de réglages reçoit : les seuls champs modifiables, jamais les secrets, et
 * de quoi montrer ce qui s'écarte du dépôt.
 */
function forUi(name) {
  const spec = SECTIONS[name];
  const effective = read(name);
  const custom = overrides()[name] || {};

  const values = {};
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.type === SECRET) {
      values[key] = '';
      values[`${key}Set`] = Boolean(effective[key]);
    } else {
      values[key] = effective[key] === undefined ? defaultOf(field) : effective[key];
    }
  }
  return { values, overridden: Object.keys(custom) };
}

function defaultOf(field) {
  if (field.type === 'bool') return false;
  if (field.type === 'set' || field.type === 'lines' || field.type === 'groups') return [];
  if (field.type === 'port') return 587;
  if (field.type === 'enum') return field.values[0];
  return '';
}

function all() {
  const out = {};
  for (const name of NAMES) out[name] = forUi(name);
  return out;
}

module.exports = { read, save, reset, clean, merge, forUi, all, SECTIONS, NAMES, FILE };
