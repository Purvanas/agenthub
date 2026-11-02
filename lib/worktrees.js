'use strict';

// Un dossier de travail isolé par conversation, sur une branche à elle.
//
// Sans ça, deux conversations lancées sur le même projet écrivent dans les mêmes fichiers.
// Le dégât n'est pas seulement le conflit d'édition : l'instantané pris avant chaque turn
// (`lib/checkpoints.js`) enregistre alors le travail de la voisine comme s'il était le sien,
// et une restauration défait ce que personne ne lui avait demandé de défaire.
//
// Un worktree git règle les deux d'un coup — même dépôt, même historique, deux répertoires
// et deux branches. Le dépôt fantôme suit le worktree, donc ne voit plus que ses fichiers.
//
// Ce que ce module ne fait pas : décider. Il crée, mesure et fusionne sur demande ; il ne
// fusionne jamais tout seul et ne supprime jamais une branche qui porte du travail.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const WT_DIR = path.join(DATA_DIR, 'worktrees');
const TIMEOUT_MS = 120_000;

/** Préfixe des branches créées ici : elles doivent se reconnaître dans un `git branch`. */
const BRANCH_PREFIX = 'agenthub/';

/**
 * Dossiers lourds et régénérables reliés par lien symbolique au lieu d'être recopiés.
 *
 * Un worktree neuf n'a pas de `node_modules`, donc pas de tests exécutables tant qu'une
 * installation n'a pas tourné — plusieurs minutes avant le premier `npm test`, à chaque
 * conversation. Une copie serait pire : le disque est en ext4, donc sans copie
 * copy-on-write, et c'est 300 Mo à recopier pour de bon.
 *
 * Le lien a un défaut qu'il faut connaître : `npm install` lancé dans le worktree écrit
 * dans le `node_modules` du dépôt principal, qui redevient un état partagé. Les
 * *déclarations* restent isolées — `package.json` et le lock sont des fichiers versionnés,
 * donc propres à la branche. C'est la dépendance installée qui déborde, et un `npm ci`
 * dans le dépôt principal la remet d'aplomb.
 */
const LINKED = ['node_modules', '.venv', 'venv', '.pnpm-store'];

function gitRun(cwd, args) {
  return run('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 32 << 20,
  }).then(({ stdout }) => stdout);
}

/**
 * Racine du dépôt contenant ce dossier, ou null s'il n'est pas versionné.
 *
 * `--show-toplevel` et non `--git-dir` : on veut le répertoire de travail, et depuis un
 * worktree les deux ne désignent pas le même endroit.
 */
async function repoRoot(dir) {
  try {
    const out = await gitRun(dir, ['rev-parse', '--show-toplevel']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Le dépôt a-t-il au moins un commit ? Sans HEAD, `worktree add` n'a rien d'où partir. */
async function hasCommit(repo) {
  try {
    await gitRun(repo, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** La branche existe-t-elle déjà dans ce dépôt ? */
async function branchExists(repo, branch) {
  try {
    await gitRun(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Branche actuellement sortie dans un dossier, ou null en HEAD détachée. */
async function currentBranch(dir) {
  try {
    const out = await gitRun(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Nom de branche. Le préfixe des huit premiers caractères de l'identifiant de conversation
 * suffit à garantir l'unicité, et se retrouve à l'œil dans le graphe git.
 */
function branchName(convId) {
  return `${BRANCH_PREFIX}${String(convId).slice(0, 8)}`;
}

function worktreePath(convId) {
  return path.join(WT_DIR, String(convId));
}

/** Un projet peut-il recevoir un worktree ? Sert à ne proposer l'option que quand elle marche. */
async function eligible(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, reason: 'Dossier introuvable' };
  const repo = await repoRoot(dir);
  if (!repo) return { ok: false, reason: "Ce dossier n'est pas un dépôt git" };
  if (!(await hasCommit(repo))) {
    return { ok: false, reason: "Ce dépôt n'a pas encore de commit" };
  }
  return { ok: true, repo };
}

/**
 * Relie les dossiers lourds du dépôt principal. Silencieux sur échec : un lien manquant
 * coûte une installation, pas la conversation.
 */
function linkHeavy(repo, dest) {
  const linked = [];
  for (const name of LINKED) {
    const from = path.join(repo, name);
    const to = path.join(dest, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.symlinkSync(from, to, 'dir');
      linked.push(name);
    } catch (err) {
      console.error(`lien ${name} impossible dans ${dest} : ${err.message}`);
    }
  }
  return linked;
}

/**
 * Crée le worktree d'une conversation. Rejette si le dossier n'est pas un dépôt utilisable :
 * mieux vaut refuser la création que rendre une conversation qui travaille ailleurs que là
 * où on croit.
 *
 * @returns {Promise<{repo: string, path: string, branch: string, base: string, linked: string[]}>}
 */
async function create({ convId, cwd }) {
  const check = await eligible(cwd);
  if (!check.ok) throw new Error(check.reason);
  const repo = check.repo;

  const dest = worktreePath(convId);
  const branch = branchName(convId);
  if (fs.existsSync(dest)) throw new Error('Cette conversation a déjà un worktree');

  fs.mkdirSync(WT_DIR, { recursive: true });

  // La base est relevée avant l'ajout : c'est ce qui permettra plus tard de dire combien de
  // commits la branche a pris d'avance, même si le dépôt principal a bougé depuis.
  const base = (await currentBranch(repo)) || 'HEAD';
  const baseSha = (await gitRun(repo, ['rev-parse', 'HEAD'])).trim();

  // La branche peut déjà exister : un worktree effacé à la main laisse la sienne derrière
  // lui, puisqu'on refuse de supprimer une branche qui porte peut-être du travail. On la
  // reprend au lieu d'échouer — c'est exactement le travail qu'on cherche à retrouver.
  const reused = await branchExists(repo, branch);
  const args = reused
    ? ['worktree', 'add', dest, branch]
    : ['worktree', 'add', '-b', branch, dest, baseSha];
  try {
    await gitRun(repo, args);
  } catch (err) {
    const reason = (err.stderr || err.message || '').toString().trim().slice(0, 300);
    throw new Error(`Worktree impossible : ${reason}`);
  }

  return { repo, path: dest, branch, base, baseSha, reused, linked: linkHeavy(repo, dest) };
}

/**
 * Où en est la branche d'un worktree.
 *
 * `dirty` compte ce qui n'est pas commité : un agent laisse très souvent son travail dans
 * le répertoire sans le commiter, et une fusion silencieuse ne le prendrait pas. C'est la
 * première chose à savoir avant de proposer de fusionner.
 *
 * @returns {Promise<{ahead: number, dirty: number, target: string|null, missing?: boolean}>}
 */
async function state(wt) {
  if (!wt || !fs.existsSync(wt.path)) return { ahead: 0, dirty: 0, target: null, missing: true };
  const status = await gitRun(wt.path, ['status', '--porcelain']);
  const dirty = status.split('\n').filter((l) => l.trim()).length;

  const target = await currentBranch(wt.repo);
  let ahead = 0;
  try {
    // Comptés contre la branche du dépôt principal quand il y en a une, et contre le point
    // de départ sinon : c'est « ce que la fusion apporterait », pas « ce qui a été commité ».
    const against = target && target !== wt.branch ? target : wt.baseSha;
    const out = await gitRun(wt.path, ['rev-list', '--count', `${against}..HEAD`]);
    ahead = Number(out.trim()) || 0;
  } catch {
    ahead = 0;
  }
  return { ahead, dirty, target };
}

/**
 * Fusionne la branche du worktree dans celle sortie du dépôt principal.
 *
 * Trois refus, tous délibérés :
 *
 * - **Travail non commité dans le worktree** — il ne serait pas fusionné, et on croirait que
 *   si. C'est le cas le plus fréquent, un agent commitant rarement de lui-même.
 * - **Dépôt principal sale** — une fusion par-dessus des modifications en cours mélange deux
 *   travaux dont un seul est visible ici.
 * - **Conflit** — la fusion est annulée plutôt que laissée à mi-chemin. Un dépôt principal en
 *   état de conflit est un piège pour la personne suivante, agent ou humain, qui l'ouvrira
 *   sans savoir d'où il vient.
 */
async function merge(wt) {
  const info = await state(wt);
  if (info.missing) throw new Error('Le worktree de cette conversation a disparu');
  if (info.dirty) {
    throw new Error(
      `${info.dirty} fichier(s) non commité(s) dans le worktree : commite-les d'abord, ` +
        'sinon la fusion les laisserait derrière elle.'
    );
  }
  if (!info.target) {
    throw new Error("Le dépôt principal est en HEAD détachée : rien à fusionner vers là.");
  }
  if (info.target === wt.branch) {
    throw new Error('Le dépôt principal est déjà sur cette branche.');
  }
  if (!info.ahead) throw new Error(`Rien à fusionner : ${wt.branch} n'a pris aucune avance.`);

  const mainStatus = await gitRun(wt.repo, ['status', '--porcelain']);
  if (mainStatus.split('\n').filter((l) => l.trim()).length) {
    throw new Error(
      `Le dépôt principal a des modifications en cours sur ${info.target} : ` +
        'range-les avant de fusionner.'
    );
  }

  try {
    await gitRun(wt.repo, ['merge', '--no-ff', '--no-edit', wt.branch]);
  } catch (err) {
    const reason = (err.stderr || err.message || '').toString().trim().slice(0, 300);
    try {
      await gitRun(wt.repo, ['merge', '--abort']);
    } catch {
      /* rien à annuler : la fusion avait échoué avant de commencer */
    }
    throw new Error(`Fusion impossible, elle a été annulée : ${reason}`);
  }

  const sha = (await gitRun(wt.repo, ['rev-parse', 'HEAD'])).trim();
  return { merged: wt.branch, into: info.target, commits: info.ahead, sha };
}

/**
 * Retire le worktree. La branche est conservée dès qu'elle porte quelque chose : supprimer
 * une conversation ne doit pas emporter le travail qu'elle a produit. Une branche restée à
 * son point de départ, elle, n'a rien à préserver et ne laisserait qu'un déchet.
 *
 * @returns {Promise<{removed: boolean, branchKept: boolean, branch: string}>}
 */
async function remove(wt) {
  if (!wt || !wt.repo) return { removed: false, branchKept: false, branch: null };

  let keep = true;
  try {
    const info = await state(wt);
    keep = Boolean(info.missing || info.ahead || info.dirty);
  } catch {
    keep = true; // dans le doute, on garde
  }

  try {
    await gitRun(wt.repo, ['worktree', 'remove', '--force', wt.path]);
  } catch {
    // Le dossier a pu être supprimé à la main, ou le dépôt déplacé. On nettoie ce qu'on
    // peut : sans le `prune`, git garderait une référence vers un worktree inexistant et
    // refuserait d'en recréer un au même endroit.
    fs.rmSync(wt.path, { recursive: true, force: true });
    try {
      await gitRun(wt.repo, ['worktree', 'prune']);
    } catch {
      /* dépôt disparu : il n'y a plus rien à nettoyer */
    }
  }

  if (!keep) {
    try {
      await gitRun(wt.repo, ['branch', '-D', wt.branch]);
    } catch {
      /* branche déjà partie, ou sortie ailleurs */
    }
  }
  return { removed: true, branchKept: keep, branch: wt.branch };
}

module.exports = {
  WT_DIR,
  BRANCH_PREFIX,
  LINKED,
  TIMEOUT_MS,
  branchName,
  worktreePath,
  repoRoot,
  currentBranch,
  eligible,
  branchExists,
  create,
  state,
  merge,
  remove,
};
