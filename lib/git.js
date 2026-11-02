'use strict';

// Graphe du dépôt réel du dossier de travail, pour le panneau de la vue conversation.
//
// Rien de maintenu ne dessine un DAG git dans un navigateur. GitGraph.js, la référence
// historique, est archivée depuis juillet 2024 et sans reprise depuis 2019. Le `gitGraph`
// de Mermaid est vivant mais déclaratif et en ordre d'insertion : il sert à écrire un
// schéma à la main, pas à rendre une histoire réelle. `git-history-ui` est complet et
// actif, mais son helmet fixe `frame-ancestors: 'none'` : c'est un onglet à part, pas un
// panneau qu'on déplie ici.
//
// Ce module ne demande donc à git que ce que git seul sait : la liste des commits dans un
// ordre topologique, avec leurs parents. Le placement en colonnes est calculé par
// `lib/lanes.js`, et le dessin est fait en SVG côté navigateur.
//
// Une première version lisait le dessin ASCII de `git log --graph` pour ne rien avoir à
// placer. Ça marchait, mais ça ne donne que du texte : pas de lanes colorées, pas de nœuds
// ronds, pas de courbes. Le placement est donc repassé à notre charge — c'est un calcul pur,
// donc entièrement testable, et il tient en une centaine de lignes.
//
// Le format met le séparateur **en premier**, ce qui marque la fin exacte du préfixe et rend
// le découpage insensible à ce que contiennent les champs. Le sha complet (`%H`) sert à
// rapprocher les parents, l'abrégé (`%h`) à l'affichage : rapprocher sur l'abrégé exposerait
// à une collision de préfixe sur un gros dépôt.
//
// Ce module ne touche jamais au dépôt : uniquement `rev-parse`, `log` et `status`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { assignLanes } = require('./lanes');

const run = promisify(execFile);

/** Séparateur d'unité ASCII : absent d'un message de commit comme d'un nom d'auteur. */
const SEP = '\x1f';

const FIELDS = ['%H', '%h', '%P', '%D', '%an', '%ae', '%at', '%s'];
const FORMAT = `%x1f${FIELDS.join('%x1f')}`;

/**
 * Empreinte Gravatar d'une adresse : SHA-256 de l'adresse en minuscules, sans espaces.
 *
 * Calculée **ici** et pas dans le navigateur, pour deux raisons. `crypto.subtle` n'existe
 * qu'en contexte sécurisé, et l'app est souvent servie en HTTP clair (localhost / VPN) :
 * le hachage côté page ne marcherait simplement pas. Et le panneau n'a alors besoin que de
 * l'empreinte, jamais de l'adresse elle-même pour aller chercher l'image.
 */
function avatarHash(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  return crypto.createHash('sha256').update(clean).digest('hex');
}

const TIMEOUT_MS = 10_000;
// Un fetch passe par le réseau : il lui faut plus d'air qu'à une lecture locale, sans pour
// autant pouvoir retenir l'affichage indéfiniment.
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 << 20;

/** Au-delà, le panneau coûte plus à lire qu'il n'apprend. */
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 400;

function git(args, cwd) {
  return run('git', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
}

/** Nombre de commits demandé, ramené dans les bornes. */
function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Racine du dépôt qui contient `cwd`, ou null s'il n'y en a pas.
 *
 * C'est aussi la sonde qui décide si le bouton du panneau existe : un dossier de travail
 * peut très bien n'être pas versionné, et `--show-toplevel` répond en quelques
 * millisecondes. On remonte la racine plutôt qu'un booléen parce qu'un `cwd` peut être un
 * sous-dossier du dépôt, et c'est la racine qui a du sens à afficher.
 */
async function root(cwd) {
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel'], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Décortique une décoration de git : « HEAD -> dev, origin/dev, tag: v1 ».
 *
 * Chaque ref est classée, parce que l'affichage les distingue : la branche courante, une
 * branche locale, une distante, une étiquette. `HEAD -> dev` compte comme la branche `dev`
 * marquée courante, et non comme une ref nommée « HEAD -> dev » — c'est ce qui permet de la
 * montrer une seule fois.
 */
function parseRefs(text) {
  const out = [];
  for (const raw of String(text || '').split(', ')) {
    const ref = raw.trim();
    if (!ref) continue;

    if (ref.startsWith('tag: ')) {
      out.push({ name: ref.slice(5), kind: 'tag', head: false });
    } else if (ref.startsWith('HEAD -> ')) {
      out.push({ name: ref.slice(8), kind: 'local', head: true });
    } else if (ref === 'HEAD') {
      // HEAD seul : détaché, il ne pointe sur aucune branche.
      out.push({ name: 'HEAD', kind: 'head', head: true });
    } else if (ref.includes('/')) {
      out.push({ name: ref, kind: 'remote', head: false });
    } else {
      out.push({ name: ref, kind: 'local', head: false });
    }
  }
  return out;
}

/**
 * Traduit la sortie de `git log` en commits.
 *
 * @param {string} stdout
 * @returns {Array<{sha: string, short: string, parents: string[], refs: Array,
 *   author: string|null, email: string|null, avatar: string|null, at: number|null,
 *   subject: string}>}
 */
function parseLog(stdout) {
  const commits = [];
  for (const raw of String(stdout).split('\n')) {
    if (!raw.startsWith(SEP)) continue;

    // Le sujet est pris en dernier et rejoint : un message contenant un 0x1f ne décalerait
    // pas les champs.
    const [sha, short, parents, refs, author, email, at, ...rest] = raw.slice(SEP.length).split(SEP);
    if (!sha) continue;

    const seconds = Number(at);
    commits.push({
      sha,
      short: short || sha.slice(0, 9),
      parents: String(parents || '').split(' ').filter(Boolean),
      refs: parseRefs(refs),
      author: author || null,
      // L'adresse distingue deux identités du même nom — et deux noms de la même personne,
      // ce qu'un dépôt tenu depuis plusieurs machines produit tout seul.
      email: email || null,
      avatar: avatarHash(email),
      at: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      subject: rest.join(SEP),
    });
  }
  return commits;
}

/**
 * État du dossier de travail, lu dans `status --porcelain=v2 --branch`.
 *
 * La version 2 du format est choisie pour ses en-têtes `# branch.*` : la branche courante,
 * son amont et l'écart en commits y sont donnés tels quels, là où la v1 obligeait à les
 * déduire. `dirty` compte les lignes de fichiers, en-têtes exclus.
 */
function parseStatus(stdout) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    if (!line.startsWith('# ')) {
      out.dirty += 1;
      continue;
    }
    const [key, ...rest] = line.slice(2).split(' ');
    const value = rest.join(' ');
    // « (detached) » est la réponse de git pour un HEAD détaché : elle vaut mieux que null,
    // c'est exactement ce qu'on veut lire dans le panneau.
    if (key === 'branch.head') out.branch = value || null;
    else if (key === 'branch.upstream') out.upstream = value || null;
    else if (key === 'branch.ab') {
      const m = /^\+(\d+)\s+-(\d+)$/.exec(value);
      if (m) {
        out.ahead = Number(m[1]);
        out.behind = Number(m[2]);
      }
    }
  }
  return out;
}

/** Branche, amont, écart et nombre de fichiers modifiés. Silencieux en cas d'échec. */
async function state(cwd) {
  try {
    const { stdout } = await git(['status', '--porcelain=v2', '--branch'], cwd);
    return parseStatus(stdout);
  } catch {
    return { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  }
}

/**
 * Âge du dernier `git fetch`, en millisecondes, ou `null` si le dépôt n'a jamais été
 * interrogé.
 *
 * Un panneau qui lit un clone en retard n'affiche rien de faux, mais il laisse croire qu'il
 * n'y a rien de plus récent — ce qui est pire qu'une erreur, parce qu'on lui fait confiance.
 * Relevé sur un dépôt réel : le dernier fetch datait de deux heures, et des commits poussés
 * entre-temps étaient invisibles. `FETCH_HEAD` porte la date, c'est git lui-même qui l'écrit.
 */
async function fetchAge(cwd) {
  const top = await root(cwd);
  if (!top) return null;
  try {
    const { mtimeMs } = fs.statSync(path.join(top, '.git', 'FETCH_HEAD'));
    return Date.now() - mtimeMs;
  } catch {
    return null;
  }
}

/** Au-delà, on considère le clone assez vieux pour valoir un fetch avant de dessiner. */
const STALE_MS = 60_000;

/**
 * Met à jour les références distantes.
 *
 * `--no-tags` et pas de `--prune` : on veut savoir ce qui est arrivé, pas réorganiser le
 * dépôt de quelqu'un d'autre. Le délai est court — un fetch qui traîne ne doit pas retenir
 * l'affichage du graphe, dont les données locales sont déjà utilisables.
 *
 * Ne lance jamais : sans réseau, sans droit, sans distant, le panneau reste utile.
 * @returns {Promise<{fetched: boolean, reason?: string}>}
 */
async function fetch(cwd) {
  try {
    await run('git', ['fetch', '--no-tags', '--quiet'], {
      cwd,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { fetched: true };
  } catch (err) {
    const reason = String((err && err.stderr) || (err && err.message) || '').trim();
    return { fetched: false, reason: reason.slice(0, 200) || 'échec du fetch' };
  }
}

/**
 * Graphe placé et état du dépôt de `cwd`.
 *
 * Toutes les références sont dessinées, branches distantes comprises. Un graphe qui omet une
 * branche existante donne une vision fausse du dépôt ; le coût éventuel en colonnes est donc
 * assumé plutôt que caché derrière une préférence d'affichage.
 *
 * `--topo-order` est explicite : `--graph` l'impliquait, et sans lui l'ordre serait
 * chronologique — ce qui entrelacerait les branches et multiplierait les colonnes.
 *
 * @param {string} cwd
 * @param {{limit?: number, fetch?: boolean}} [opts]
 */
async function graph(cwd, opts = {}) {
  const top = await root(cwd);
  if (!top) return { repo: false };

  // Rafraîchir les références distantes avant de dessiner, sauf si c'est déjà récent.
  // Sans ça le panneau montre fidèlement un clone en retard, ce qui est pire qu'une erreur :
  // il laisse croire qu'il n'y a rien de plus neuf. Un `fetch` explicite (`opts.fetch`)
  // passe outre le délai de grâce.
  let fetched = null;
  const age = await fetchAge(cwd);
  if (opts.fetch || age === null || age > STALE_MS) {
    fetched = await fetch(cwd);
  }

  const limit = clampLimit(opts.limit);
  const args = [
    'log',
    '--topo-order',
    '--decorate=short',
    `--max-count=${limit}`,
    `--pretty=format:${FORMAT}`,
    '--all',
    'HEAD',
  ];

  let commits;
  try {
    const { stdout } = await git(args, cwd);
    commits = parseLog(stdout);
  } catch (err) {
    // Un dépôt fraîchement créé n'a pas de commit et `log` échoue. Ce n'est pas une panne :
    // le panneau doit dire « aucun commit », pas afficher une erreur.
    const reason = String((err && err.stderr) || (err && err.message) || '').trim();
    if (/does not have any commits|unknown revision|bad revision/i.test(reason)) {
      return {
        repo: true,
        root: top,
        empty: true,
        columns: 1,
        rows: [],
        edges: [],
        truncated: false,
        ...(await state(cwd)),
      };
    }
    throw err;
  }

  const placed = assignLanes(commits);
  return {
    repo: true,
    root: top,
    empty: commits.length === 0,
    all: true,
    limit,
    columns: placed.columns,
    rows: placed.rows,
    edges: placed.edges,
    truncated: commits.length >= limit,
    // Ce que le panneau doit pouvoir dire de sa propre fraîcheur : quand le dépôt a été
    // interrogé, et si la tentative de cette fois a échoué (hors ligne, pas de distant).
    fetchedAgeMs: await fetchAge(cwd),
    fetchFailed: fetched && !fetched.fetched ? fetched.reason : null,
    ...(await state(cwd)),
  };
}

module.exports = {
  graph,
  root,
  fetch,
  fetchAge,
  parseLog,
  parseRefs,
  parseStatus,
  avatarHash,
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STALE_MS,
  SEP,
};
