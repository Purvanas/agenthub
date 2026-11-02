'use strict';

// Instantanés du dossier de travail, pris avant chaque turn.
//
// Le rewind natif de Claude Code n'est pas accessible en mode non-interactif
// (`/rewind isn't available in this environment`), et rembobiner sa conversation
// demanderait de réécrire son arbre de session — format privé, non documenté. On
// couvre donc la moitié qui compte, les fichiers, avec un mécanisme à nous.
//
// Chaque conversation a un dépôt git « fantôme » rangé dans les données d'agentHub,
// dont le work-tree pointe vers le dossier du projet. Aucun `.git` n'est écrit dans
// le projet, rien ne touche son dépôt réel s'il en a un, et ça marche donc aussi
// bien sur un dossier versionné que sur un dossier ordinaire.
//
// Tout est asynchrone : un premier instantané d'un gros dépôt prend plusieurs
// secondes (mesuré à 4,7 s sur 277 Mo), et en synchrone ça gelait la boucle
// d'événements — donc les websockets et le streaming de toutes les conversations.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const CP_DIR = path.join(DATA_DIR, 'checkpoints');
const TIMEOUT_MS = 90_000;

// Le `.git` du projet est exclu en premier : sans ça on archiverait les entrailles
// de son dépôt réel. Le reste, ce sont les dossiers lourds et régénérables.
const EXCLUDES = [
  // Sans barre finale, délibérément : dans un worktree git, `.git` est un *fichier* qui
  // pointe vers le dépôt principal, et non un dossier. Un motif ancré sur les répertoires
  // le laissait passer — le dépôt fantôme archivait alors le lien du worktree, et une
  // restauration pouvait le réécrire vers un chemin qui n'existe plus.
  '.git',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pnpm-store/',
  '.next/',
  '.nuxt/',
  '.cache/',
  'dist/',
  'build/',
  'target/',
  'coverage/',
  '.DS_Store',
  '*.log',
  '*.tmp',
  '*.swp',
  '.terraform/',
];

fs.mkdirSync(CP_DIR, { recursive: true });

function gitDir(convId) {
  return path.join(CP_DIR, `${convId}.git`);
}

/**
 * Position du dossier de données d'agentHub par rapport au dossier suivi.
 *
 * Une conversation dont le dossier de travail est agentHub lui-même archive `data/` —
 * donc les dépôts fantômes des *autres* conversations, qui s'appellent `<uuid>.git` et
 * que le motif `.git/` n'attrape pas. Mesuré avant correction : 228 Mo pour une seule
 * conversation, 1022 fichiers suivis sur 1050 sous `data/`, et ça grossit à chaque turn.
 *
 * Le vrai risque n'est pas la place disque : une restauration ferait un `reset --hard`
 * sur `data/` et réécrirait les conversations, les images et les instantanés.
 *
 * @returns {string|null} chemin relatif du dossier de données, '' s'il *est* le dossier
 *   de travail, null s'il est ailleurs (le cas courant : rien à exclure).
 */
function dataRelative(cwd) {
  const rel = path.relative(path.resolve(cwd), path.resolve(DATA_DIR));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** Motifs d'exclusion du dépôt fantôme, dossier de données compris s'il est dedans. */
function excludesFor(cwd) {
  const rel = dataRelative(cwd);
  if (rel === null) return EXCLUDES;
  // Le `/` initial ancre le motif à la racine du work-tree : on n'exclut pas un `data/`
  // qui se trouverait plus bas dans l'arborescence du projet suivi.
  return [...EXCLUDES, rel === '' ? '/*' : `/${rel}/`];
}

/**
 * Un motif d'exclusion ne détache pas ce qui est déjà suivi : sans ça, les dépôts créés
 * avant cette correction continueraient d'archiver `data/` à chaque instantané. Les
 * fichiers restent sur le disque, seul l'index les oublie.
 */
async function untrackData(convId, cwd) {
  const rel = dataRelative(cwd);
  if (rel === null) return;
  try {
    await git(convId, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', rel || '.']);
  } catch (err) {
    const reason = (err.stderr || err.message || '').toString().trim().slice(0, 200);
    console.error(`détachement de ${rel || '.'} impossible (${convId}) : ${reason}`);
  }
}

/** Cet instantané contient-il le dossier de données ? Si oui, le restaurer l'écraserait. */
async function tracksData(convId, cwd, sha) {
  const rel = dataRelative(cwd);
  if (rel === null) return false;
  const out = await git(convId, ['ls-tree', '-r', '--name-only', sha, '--', rel || '.']);
  return Boolean(out.trim());
}

async function git(convId, args) {
  const { stdout } = await run(
    'git',
    [
      '--git-dir', gitDir(convId),
      '-c', 'user.name=agentHub',
      '-c', 'user.email=agenthub@localhost',
      '-c', 'core.autocrlf=false',
      '-c', 'core.fileMode=false',
      ...args,
    ],
    { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 32 << 20 }
  );
  return stdout;
}

async function ensureRepo(convId, cwd) {
  const dir = gitDir(convId);
  const fresh = !fs.existsSync(dir);

  if (fresh) {
    await run('git', ['init', '--quiet', '--bare', dir], { timeout: TIMEOUT_MS });
    // Dépôt non-bare avec un work-tree externe : c'est ce qui permet de suivre un
    // dossier sans y déposer quoi que ce soit.
    await run('git', ['--git-dir', dir, 'config', 'core.bare', 'false'], { timeout: TIMEOUT_MS });
    await run('git', ['--git-dir', dir, 'config', 'core.worktree', cwd], { timeout: TIMEOUT_MS });
  }

  // La liste d'exclusions est vérifiée à chaque instantané et non à la seule création :
  // c'est ce qui rattrape les dépôts existants quand elle change.
  const excludeFile = path.join(dir, 'info', 'exclude');
  const wanted = `${excludesFor(cwd).join('\n')}\n`;
  let current = null;
  try {
    current = fs.readFileSync(excludeFile, 'utf8');
  } catch {
    /* dépôt neuf, ou fichier absent */
  }
  if (current === wanted) return;

  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.writeFileSync(excludeFile, wanted);
  if (!fresh) await untrackData(convId, cwd);
}

/**
 * Prend un instantané. Ne rejette jamais : un échec ne doit pas empêcher un turn de
 * partir, il est simplement signalé.
 * @returns {Promise<{sha: string, at: string} | {error: string}>}
 */
async function snapshot(conv, label) {
  try {
    if (!fs.existsSync(conv.cwd)) return { error: 'Dossier de travail introuvable' };
    await ensureRepo(conv.id, conv.cwd);
    await git(conv.id, ['add', '-A']);
    await git(conv.id, [
      'commit', '--quiet', '--allow-empty',
      '-m', String(label || 'checkpoint').slice(0, 200),
    ]);
    const sha = (await git(conv.id, ['rev-parse', 'HEAD'])).trim();
    return { sha, at: new Date().toISOString() };
  } catch (err) {
    const reason = (err.stderr || err.message || '').toString().trim().slice(0, 200);
    console.error(`checkpoint impossible (${conv.cwd}) : ${reason}`);
    return { error: reason || "échec de l'instantané" };
  }
}

/**
 * Premier instantané de la conversation, c'est-à-dire l'état du dossier avant son tout
 * premier turn. Diffé contre l'état courant, il donne ce que la conversation a produit.
 * @returns {Promise<string|null>} null si la conversation n'a aucun instantané.
 */
async function firstSha(conv) {
  if (!fs.existsSync(gitDir(conv.id))) return null;
  const shas = (await git(conv.id, ['rev-list', '--max-parents=0', 'HEAD']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // Un dépôt fantôme n'a qu'une racine ; on prend la dernière par précaution.
  return shas.length ? shas[shas.length - 1] : null;
}

/** Fichiers modifiés entre un instantané et l'état actuel du dossier. */
async function diff(conv, sha) {
  if (!fs.existsSync(gitDir(conv.id))) throw new Error('Aucun instantané pour cette conversation');
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Référence d'instantané invalide");

  // On indexe l'état courant pour que les fichiers créés depuis apparaissent aussi.
  await git(conv.id, ['add', '-A']);
  const raw = await git(conv.id, ['diff', '--cached', '--name-status', '-M', sha]);

  const labels = {
    A: 'ajouté', M: 'modifié', D: 'supprimé',
    R: 'renommé', C: 'copié', T: 'type changé',
  };
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, ...rest] = line.split('\t');
      return { status: code[0], label: labels[code[0]] || code, path: rest.join(' → ') };
    });
}

/**
 * Restaure le dossier à l'état de l'instantané. Un instantané de sécurité est pris
 * d'abord, pour que la restauration elle-même reste annulable.
 */
async function restore(conv, sha) {
  const files = await diff(conv, sha); // valide sha et indexe l'état courant

  // Instantané pris avant que le dossier de données soit exclu : le `reset --hard`
  // remettrait `data/` dans l'état de l'époque, donc réécrirait les conversations, les
  // images et les instantanés des autres conversations. On refuse au lieu de le faire.
  if (await tracksData(conv.id, conv.cwd, sha)) {
    throw new Error(
      "Cet instantané est antérieur à l'exclusion du dossier de données : le restaurer " +
        "réécrirait data/ (conversations, images, instantanés). Restauration refusée. " +
        'Les instantanés pris depuis sont utilisables normalement.'
    );
  }

  const safety = await snapshot(conv, `avant restauration vers ${sha.slice(0, 8)}`);

  await git(conv.id, ['reset', '--hard', sha]);
  // Supprime ce qui a été créé depuis. Sans -x, les fichiers ignorés
  // (node_modules et compagnie) sont épargnés.
  await git(conv.id, ['clean', '-fd']);

  return { restored: sha, files, safety };
}

function removeConversation(convId) {
  fs.rmSync(gitDir(convId), { recursive: true, force: true });
}

module.exports = {
  snapshot,
  diff,
  restore,
  removeConversation,
  firstSha,
  dataRelative,
  excludesFor,
  CP_DIR,
  EXCLUDES,
};
