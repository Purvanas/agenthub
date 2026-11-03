'use strict';

// Ces tests font tourner de vrais dépôts git dans des dossiers temporaires. C'est plus lent
// qu'un faux, et c'est voulu : ce qu'on veut vérifier ici, ce sont les refus — fusionner du
// travail non commité, écraser un dépôt sale, supprimer une branche qui porte quelque chose.
// Un git simulé dirait toujours oui.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(require('node:child_process').execFile);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wt-'));
  process.env.AGENTHUB_DATA = path.join(dir, 'data');
  delete require.cache[require.resolve('../lib/worktrees')];
  return { worktrees: require('../lib/worktrees'), dir };
}

async function git(cwd, ...args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout;
}

/** Un dépôt avec un commit, la matière première de tous les tests ci-dessous. */
async function repoWith(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '--quiet', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@localhost');
  await git(dir, 'config', 'user.name', 'test');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', 'depart');
  return dir;
}

test('un dossier sans git ne peut pas recevoir de worktree', async () => {
  const { worktrees, dir } = fresh();
  const plain = path.join(dir, 'nu');
  fs.mkdirSync(plain, { recursive: true });
  const check = await worktrees.eligible(plain);
  assert.equal(check.ok, false);
  assert.match(check.reason, /dépôt git/);
  assert.equal((await worktrees.eligible(path.join(dir, 'absent'))).ok, false);
});

test('un dépôt sans commit est refusé, avec la vraie raison', async () => {
  const { worktrees, dir } = fresh();
  const repo = path.join(dir, 'vide');
  fs.mkdirSync(repo, { recursive: true });
  await git(repo, 'init', '--quiet', '-b', 'main');
  const check = await worktrees.eligible(repo);
  assert.equal(check.ok, false);
  assert.match(check.reason, /pas encore de commit/);
});

test('le worktree est un dossier a lui, sur une branche a lui', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'abcdef12-3456', cwd: repo });

  assert.equal(wt.branch, 'agenthub/abcdef12');
  assert.equal(wt.base, 'main');
  assert.equal(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8'), 'un\n');
  assert.equal(await worktrees.currentBranch(wt.path), 'agenthub/abcdef12');
  // Le dépôt principal n'a pas bougé de branche : c'est tout l'intérêt.
  assert.equal(await worktrees.currentBranch(repo), 'main');
});

test('ecrire dans le worktree ne touche pas le dossier principal', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });

  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'modifie\n');
  fs.writeFileSync(path.join(wt.path, 'neuf.txt'), 'ajout\n');

  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'un\n');
  assert.equal(fs.existsSync(path.join(repo, 'neuf.txt')), false);
  assert.equal((await worktrees.state(wt)).dirty, 2);
});

test('node_modules est relie au lieu d etre recopie', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  fs.mkdirSync(path.join(repo, 'node_modules', 'truc'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'truc', 'index.js'), 'module.exports = 1;\n');

  const wt = await worktrees.create({ convId: 'c1', cwd: repo });
  assert.deepEqual(wt.linked, ['node_modules']);
  assert.equal(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink(), true);
  // Le contenu est lisible depuis le worktree : c'est ce qui rend `npm test` possible tout
  // de suite, sans installation.
  assert.equal(
    fs.readFileSync(path.join(wt.path, 'node_modules', 'truc', 'index.js'), 'utf8'),
    'module.exports = 1;\n'
  );
});

test('fusionner du travail non commite est refuse', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'travail en cours\n');

  // Le piège que ce refus existe pour éviter : la fusion « réussit » et ne rapporte rien.
  await assert.rejects(() => worktrees.merge(wt), /non commité/);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'un\n');
});

test('fusionner sans avance est refuse', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });
  await assert.rejects(() => worktrees.merge(wt), /aucune avance/);
});

test('fusionner par dessus un depot principal sale est refuse', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });

  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'depuis le worktree\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'travail');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'edite a la main\n');
  await assert.rejects(() => worktrees.merge(wt), /modifications en cours/);
});

test('une fusion propre rapporte le travail dans la branche principale', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });

  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'depuis le worktree\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'travail');

  assert.equal((await worktrees.state(wt)).ahead, 1);
  const done = await worktrees.merge(wt);
  assert.equal(done.into, 'main');
  assert.equal(done.commits, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'depuis le worktree\n');
});

test('un conflit annule la fusion au lieu de laisser le depot a mi-chemin', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });

  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'version worktree\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'cote worktree');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'version principale\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '--quiet', '-m', 'cote principal');

  await assert.rejects(() => worktrees.merge(wt), /annulée/);
  // Le point qui compte : aucun marqueur de conflit ne reste dans le dossier principal.
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'version principale\n');
  assert.equal((await git(repo, 'status', '--porcelain')).trim(), '');
});

test('retirer un worktree vide emporte sa branche, un worktree qui a travaille la garde', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });

  const vide = await worktrees.create({ convId: 'vide1234', cwd: repo });
  const done = await worktrees.remove(vide);
  assert.equal(done.branchKept, false);
  assert.equal(fs.existsSync(vide.path), false);
  assert.doesNotMatch(await git(repo, 'branch', '--list'), /agenthub\/vide1234/);

  const plein = await worktrees.create({ convId: 'plein123', cwd: repo });
  fs.writeFileSync(path.join(plein.path, 'b.txt'), 'du travail\n');
  await git(plein.path, 'add', '-A');
  await git(plein.path, 'commit', '--quiet', '-m', 'travail');

  const kept = await worktrees.remove(plein);
  assert.equal(kept.branchKept, true);
  assert.equal(fs.existsSync(plein.path), false);
  assert.match(await git(repo, 'branch', '--list'), /agenthub\/plein123/);
});

test('retirer une conversation conserve le worktree et ses fichiers non commites', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'dirty123', cwd: repo });
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'modification importante\n');
  fs.writeFileSync(path.join(wt.path, 'nouveau.txt'), 'nouveau fichier\n');
  const kept = await worktrees.remove(wt);
  assert.equal(kept.removed, false);
  assert.equal(kept.reason, 'uncommitted');
  assert.equal(fs.readFileSync(path.join(wt.path, 'a.txt'), 'utf8'), 'modification importante\n');
  assert.equal(fs.readFileSync(path.join(wt.path, 'nouveau.txt'), 'utf8'), 'nouveau fichier\n');
  assert.equal(await worktrees.branchExists(repo, wt.branch), true);
});

test('un chemin de retrait exterieur aux worktrees est refuse sans toucher aux fichiers', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'intact\n' });
  const kept = await worktrees.remove({ repo, path: repo, branch: 'main' });
  assert.equal(kept.removed, false);
  assert.equal(kept.reason, 'invalid-path');
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'intact\n');
});

test('l instantane d un worktree n archive pas son lien .git', async () => {
  const { worktrees, dir } = fresh();
  delete require.cache[require.resolve('../lib/checkpoints')];
  const checkpoints = require('../lib/checkpoints');

  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });
  // Dans un worktree, `.git` est un fichier qui pointe vers le dépôt principal. Archivé
  // puis restauré, il réécrirait ce lien — vers un chemin qui n'existe plus si le dépôt
  // a bougé, ce qui casse le worktree sans que rien ne le dise.
  assert.equal(fs.statSync(path.join(wt.path, '.git')).isFile(), true);

  const snap = await checkpoints.snapshot({ id: 'c1', cwd: wt.path }, 'depart');
  assert.ok(snap.sha, snap.error);
  const tracked = await run(
    'git',
    ['--git-dir', path.join(checkpoints.CP_DIR, 'c1.git'), 'ls-tree', '-r', '--name-only', 'HEAD'],
    { encoding: 'utf8' }
  );
  assert.match(tracked.stdout, /a\.txt/);
  assert.doesNotMatch(tracked.stdout, /\.git/);
});

test('un worktree efface a la main se nettoie, et sa branche est reprise', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'c1', cwd: repo });

  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'du travail\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'travail');

  fs.rmSync(wt.path, { recursive: true, force: true });
  await worktrees.remove(wt);

  // Sans le `prune`, git garde la référence et refuse de recréer un worktree au même endroit.
  // Et la branche ayant survécu — elle porte un commit —, la recréation la reprend au lieu
  // d'échouer : c'est justement ce travail-là qu'on cherche à retrouver.
  const recree = await worktrees.create({ convId: 'c1', cwd: repo });
  assert.equal(recree.reused, true);
  assert.equal(fs.readFileSync(path.join(recree.path, 'b.txt'), 'utf8'), 'du travail\n');
});

test('un dossier et une branche déjà disparus ne sont pas annoncés comme conservés', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'disparu1', cwd: repo });
  fs.rmSync(wt.path, { recursive: true, force: true });
  await git(repo, 'worktree', 'prune');
  await git(repo, 'branch', '-D', wt.branch);

  const removed = await worktrees.remove(wt);
  assert.equal(removed.removed, true);
  assert.equal(removed.branchKept, false);
});

test('l inventaire rattache les worktrees actifs à leurs conversations', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'active123', cwd: repo });
  const rows = await worktrees.inventory({
    conversations: [{ id: 'conv-active', cwd: wt.path, project: repo, branch: wt.branch }],
    repos: [repo],
  });
  const row = rows.find((entry) => entry.branch === wt.branch);
  assert.deepEqual(row.owners, ['conv-active']);
  assert.equal(row.orphan, false);
  assert.equal(row.exists, true);
  assert.equal(row.path, wt.path);
  await assert.rejects(
    () => worktrees.resume(row, { convId: 'autreconv' }),
    /appartient encore/
  );
});

test('l inventaire retrouve un dossier sale après suppression de sa conversation', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'orphan12', cwd: repo });
  fs.writeFileSync(path.join(wt.path, 'a.txt'), 'travail non commité\n');
  await worktrees.remove(wt);

  const rows = await worktrees.inventory();
  const row = rows.find((entry) => entry.branch === wt.branch);
  assert.equal(row.orphan, true);
  assert.equal(row.exists, true);
  assert.equal(row.state.dirty, 1);
  assert.equal(row.canResume, true);
});

test('une branche conservée sans dossier reste visible et peut être reprise', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'branche1', cwd: repo });
  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'travail conservé\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'travail');
  await worktrees.remove(wt);

  const row = (await worktrees.inventory({ repos: [repo] })).find(
    (entry) => entry.branch === wt.branch
  );
  assert.equal(row.orphan, true);
  assert.equal(row.exists, false);
  assert.equal(row.state.ahead, 1);
  assert.equal(row.canResume, true);

  const resumed = await worktrees.resume(row, { convId: 'nouvelle1' });
  assert.equal(worktrees.trustedPath(resumed.cwd), true);
  assert.equal(resumed.worktree.branch, wt.branch);
  assert.equal(fs.readFileSync(path.join(resumed.cwd, 'b.txt'), 'utf8'), 'travail conservé\n');
});

test('une branche orpheline se fusionne explicitement même sans dossier', async () => {
  const { worktrees, dir } = fresh();
  const repo = await repoWith(path.join(dir, 'projet'), { 'a.txt': 'un\n' });
  const wt = await worktrees.create({ convId: 'merge123', cwd: repo });
  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'à fusionner\n');
  await git(wt.path, 'add', '-A');
  await git(wt.path, 'commit', '--quiet', '-m', 'travail');
  await worktrees.remove(wt);

  const done = await worktrees.merge({ ...wt, path: null });
  assert.equal(done.commits, 1);
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'à fusionner\n');
});
