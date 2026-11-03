'use strict';

// Secrets d'un projet : mots de passe, clés d'API, jetons, ce qu'on mettrait dans un `.env`.
//
// Le principe tient en une phrase : **l'agent sait ce dont il dispose, jamais ce que ça
// vaut**. Les noms des clés lui sont annoncés à chaque turn ; les valeurs, elles, ne
// passent que par l'environnement du process qu'il pilote. Il s'en sert comme un humain le
// ferait — `curl -H "Authorization: Bearer $GEMINI_API_KEY"` — sans les avoir lues.
//
// Pourquoi pas un `.env` dans le dossier du projet, qui serait le geste évident : un
// fichier posé dans un dépôt finit commité. Ici les valeurs vivent dans `data/`, hors du
// dépôt d'agentHub comme de celui du projet, en 0600.
//
// Trois barrières, et la troisième est la seule qui compte vraiment :
//   1. les valeurs ne sont jamais envoyées au navigateur, même à celui qui les a saisies ;
//   2. elles n'entrent jamais dans le contexte du modèle ;
//   3. si l'agent en affiche une malgré tout — un `env`, un `curl -v`, une erreur bavarde —
//      elle est masquée avant d'atteindre le fil, le journal et le websocket.
//
// La troisième existe parce que les deux premières sont des politesses : rien n'empêche
// techniquement un agent d'exécuter `echo $MDP`. Le masquage, lui, s'applique quoi qu'il
// fasse.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');

/**
 * En dessous de quatre caractères, une valeur n'est pas masquée.
 *
 * Masquer « ab » remplacerait deux lettres dans chaque mot de chaque sortie : le fil
 * deviendrait illisible et le masquage se trahirait de lui-même. Un secret aussi court n'en
 * est pas un ; l'UI le refuse pour cette raison.
 */
const MIN_LENGTH = 4;

/** Ce qui remplace une valeur repérée dans une sortie d'agent. */
const MASK = '«secret masqué»';

/**
 * Nom de clé : ce qui est un identifiant valide pour un shell POSIX. `MY_APP_PASSWORD` passe,
 * `my-app-password` non — `$my-app-password` s'y lirait comme `$my` suivi de
 * `-app-password`, et l'agent
 * croirait à une variable vide plutôt qu'à une erreur.
 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fileOf(folderId) {
  return path.join(SECRETS_DIR, `${folderId}.json`);
}

/** @returns {Object<string, {value: string, updatedAt: string}>} */
function read(folderId) {
  if (!folderId) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(folderId), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function write(folderId, entries) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const file = fileOf(folderId);
  if (!Object.keys(entries).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Écriture par fichier temporaire puis renommage : une coupure au milieu ne doit pas
  // laisser un fichier de secrets à moitié écrit, donc illisible, donc perdu.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Ce qu'on montre : les noms, jamais les valeurs. Y compris à celui qui les a saisies —
 * ce n'est pas un gestionnaire de mots de passe, et une valeur qu'on peut relire depuis un
 * navigateur est une valeur qui traverse le réseau à chaque affichage.
 *
 * @returns {Array<{name: string, updatedAt: string, length: number}>}
 */
function list(folderId) {
  return Object.entries(read(folderId))
    .map(([name, entry]) => ({
      name,
      updatedAt: entry.updatedAt || null,
      // La longueur seule aide à repérer un copier-coller tronqué, sans rien révéler.
      length: String(entry.value || '').length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** @returns {{error: string}|{name: string}} */
function set(folderId, name, value) {
  if (!folderId) return { error: 'Dossier inconnu' };
  const key = String(name || '').trim();
  if (!NAME_RE.test(key)) {
    return {
      error:
        `Nom de clé invalide : « ${key} ». Lettres, chiffres et tirets bas seulement, ` +
        'sans commencer par un chiffre — c\'est ce qu\'un shell sait lire derrière un $.',
    };
  }
  const secret = String(value == null ? '' : value);
  if (secret.length < MIN_LENGTH) {
    return { error: `Valeur trop courte : ${MIN_LENGTH} caractères minimum pour être masquable.` };
  }

  const entries = read(folderId);
  entries[key] = { value: secret, updatedAt: new Date().toISOString() };
  write(folderId, entries);
  return { name: key };
}

/**
 * Position de la quote fermante, en sautant celles qui sont échappées.
 * @returns {number} -1 si la valeur continue sur la ligne suivante
 */
function closingQuote(text, quote) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1; // le caractère suivant est échappé, quel qu'il soit
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/** Séquences d'échappement d'une valeur entre guillemets doubles. */
function unescape(text) {
  return text.replace(/\\([nrt\\"'$`])/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

/**
 * Analyse un fichier `.env` collé tel quel.
 *
 * Écrit à la main plutôt que pris à `dotenv` : la dépendance ne servirait qu'ici, et
 * surtout on veut *rendre compte* de ce qui n'a pas été compris. `dotenv` ignore
 * silencieusement une ligne qu'il ne sait pas lire ; ici une clé perdue en silence, c'est
 * un agent qui échouera plus tard sans qu'on sache pourquoi.
 *
 * Gère : `export` en préfixe, commentaires et lignes vides, guillemets simples ou doubles,
 * valeurs sur plusieurs lignes (une clé privée, un JSON), échappements dans les guillemets
 * doubles, et commentaire en fin de ligne sur une valeur non quotée.
 *
 * @returns {{entries: Array<{name: string, value: string}>, skipped: Array<{line: string, reason: string}>}}
 */
function parseEnv(text) {
  const entries = [];
  const skipped = [];
  const lines = String(text || '').split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    i += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*([\s\S]*)$/.exec(line);
    if (!match) {
      skipped.push({ line: raw.trim().slice(0, 60), reason: 'ni une affectation ni un commentaire' });
      continue;
    }

    const name = match[1];
    const rest = match[2];
    const quote = rest[0] === '"' || rest[0] === "'" ? rest[0] : null;
    let value;

    if (quote) {
      const opened = rest.slice(1);
      const end = closingQuote(opened, quote);
      let body;
      if (end !== -1) {
        body = opened.slice(0, end);
      } else {
        // Valeur ouverte : elle court sur les lignes suivantes — une clé privée, un JSON —
        // jusqu'à la quote fermante.
        body = opened;
        let closed = false;
        while (!closed && i < lines.length) {
          const next = lines[i];
          i += 1;
          const at = closingQuote(next, quote);
          if (at === -1) {
            body += `\n${next}`;
          } else {
            body += `\n${next.slice(0, at)}`;
            closed = true;
          }
        }
        if (!closed) skipped.push({ line: name, reason: 'guillemet jamais refermé' });
      }
      value = quote === '"' ? unescape(body) : body;
    } else {
      // Non quotée : un `#` précédé d'un espace ouvre un commentaire.
      value = rest.replace(/\s+#.*$/, '').trim();
    }

    entries.push({ name, value });
  }

  return { entries, skipped };
}

/**
 * Importe un `.env` entier. Fusionne plutôt que remplace : coller un fichier partiel ne
 * doit pas faire disparaître les clés saisies à la main.
 *
 * @returns {{saved: string[], replaced: string[], rejected: Array<{name: string, reason: string}>,
 *   skipped: Array<{line: string, reason: string}>}}
 */
function importEnv(folderId, text) {
  const { entries, skipped } = parseEnv(text);
  const current = read(folderId);
  const saved = [];
  const replaced = [];
  const rejected = [];
  const now = new Date().toISOString();

  for (const { name, value } of entries) {
    if (!NAME_RE.test(name)) {
      rejected.push({ name, reason: 'nom illisible par un shell' });
      continue;
    }
    if (value.length < MIN_LENGTH) {
      rejected.push({ name, reason: `moins de ${MIN_LENGTH} caractères` });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, name)) replaced.push(name);
    else saved.push(name);
    current[name] = { value, updatedAt: now };
  }

  // Une seule écriture pour tout le fichier : trente clés ne valent pas trente cycles
  // lecture-écriture, et un import à moitié appliqué serait pire qu'un import refusé.
  if (saved.length || replaced.length) write(folderId, current);
  return { saved, replaced, rejected, skipped };
}

/** @returns {boolean} true si la clé existait */
function remove(folderId, name) {
  const entries = read(folderId);
  if (!Object.prototype.hasOwnProperty.call(entries, name)) return false;
  delete entries[name];
  write(folderId, entries);
  return true;
}

/** Supprime tous les secrets d'un dossier supprimé. */
function forget(folderId) {
  if (!folderId) return;
  fs.rmSync(fileOf(folderId), { force: true });
}

/** Variables d'environnement à ajouter au process d'un agent. */
function env(folderId) {
  const out = {};
  for (const [name, entry] of Object.entries(read(folderId))) out[name] = entry.value;
  return out;
}

/** Noms des clés, pour les annoncer à l'agent. */
function names(folderId) {
  return Object.keys(read(folderId)).sort();
}

/** Valeurs à masquer dans les sorties. Triées par longueur décroissante : une valeur
 * contenue dans une autre doit être remplacée après elle, sinon le masquage laisse un
 * fragment de la plus longue. */
function values(folderId) {
  return Object.values(read(folderId))
    .map((entry) => String(entry.value || ''))
    .filter((v) => v.length >= MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/** Remplace toute occurrence d'un secret par le masque. */
function redact(text, list_) {
  if (!list_ || !list_.length || typeof text !== 'string' || !text) return text;
  let out = text;
  for (const value of list_) {
    if (out.includes(value)) out = out.split(value).join(MASK);
  }
  return out;
}

/**
 * Masque en profondeur : un secret peut sortir dans le texte d'un message, dans le
 * résultat d'un outil, mais aussi dans les **arguments** d'un outil — un agent qui écrit
 * `curl -H "Authorization: Bearer sk-…"` en clair au lieu d'utiliser `$VAR` l'expose dans
 * la commande elle-même.
 *
 * Renvoie une copie quand quelque chose a été masqué, l'objet d'origine sinon : ça évite
 * de recopier chaque item d'une conversation qui n'a aucun secret.
 */
function redactDeep(value, list_) {
  if (!list_ || !list_.length) return value;

  if (typeof value === 'string') return redact(value, list_);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = redactDeep(v, list_);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const next = redactDeep(v, list_);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Bloc ajouté au prompt envoyé au CLI — jamais au message stocké dans le fil.
 *
 * Il annonce les clés et le contrat. Deux précisions apprises en l'écrivant : dire *où*
 * elles sont (l'environnement, pas un fichier à chercher), et dire quoi faire quand on a
 * besoin de montrer une commande — sinon un agent consciencieux recopie la valeur dans son
 * explication, en croyant bien faire.
 */
function promptBlock(folderId) {
  const keys = names(folderId);
  if (!keys.length) return '';
  return [
    '',
    '---',
    "Secrets à ta disposition pour ce projet. Ils sont déjà dans les variables " +
      "d'environnement de ta session ; tu n'as aucun fichier à chercher ni à créer :",
    keys.map((k) => `- $${k}`).join('\n'),
    '',
    "Sers-t'en en écrivant `$NOM` dans tes commandes, jamais la valeur. Ne les affiche " +
      'pas, ne les recopie pas dans une explication, ne les écris dans aucun fichier. Si tu ' +
      'dois montrer une commande, montre-la avec `$NOM` dedans.',
    'Toute valeur qui apparaîtrait quand même dans ta sortie est masquée avant affichage : ' +
      'la fuite ne sera pas visible, mais elle aura eu lieu.',
  ].join('\n');
}

module.exports = {
  list,
  set,
  parseEnv,
  importEnv,
  remove,
  forget,
  env,
  names,
  values,
  redact,
  redactDeep,
  promptBlock,
  MIN_LENGTH,
  MASK,
  NAME_RE,
  SECRETS_DIR,
};
