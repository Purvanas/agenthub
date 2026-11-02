'use strict';

// Lecture de `git log` et de `git status --porcelain=v2`.
//
// Le placement en colonnes est testé à part, dans `lanes.test.js`. Ce qui reste ici, c'est le
// découpage de la sortie de git : séparer les champs sans jamais confondre le sujet avec ce
// qui le suit, et classer les décorations — la branche courante, une locale, une distante, une
// étiquette n'ont pas le même rendu.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(require('node:child_process').execFile);
const git = require('../lib/git');

const {
  parseLog,
  parseRefs,
  parseStatus,
  clampLimit,
  avatarHash,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SEP,
} = require('../lib/git');

/** Compose une ligne comme git la produit : séparateur d'abord, puis les huit champs. */
const line = (sha, short, parents, refs, author, at, subject, email = 'p@exemple.fr') =>
  SEP + [sha, short, parents, refs, author, email, at, subject].join(SEP);

test('une ligne de log se découpe en tous ses champs', () => {
  const [k] = parseLog(
    line(
      '378b612f8aa9',
      '378b612f8',
      '2c442884d1 ff01234567',
      'HEAD -> dev',
      'dev',
      '1754200000',
      'fix: le port',
      'dev@example.com'
    )
  );

  assert.equal(k.sha, '378b612f8aa9');
  assert.equal(k.short, '378b612f8');
  assert.deepEqual(k.parents, ['2c442884d1', 'ff01234567']);
  assert.equal(k.author, 'dev');
  assert.equal(k.email, 'dev@example.com');
  assert.equal(k.avatar, avatarHash('dev@example.com'));
  assert.equal(k.at, 1754200000 * 1000);
  assert.equal(k.subject, 'fix: le port');
});

test('l’empreinte de l’avatar ignore la casse et les espaces de l’adresse', () => {
  // Gravatar hache l'adresse en minuscules et sans espaces : la même personne doit obtenir la
  // même image quelle que soit la façon dont son `user.email` est écrit d'une machine à l'autre.
  assert.equal(avatarHash('  Dev@Example.COM '), avatarHash('dev@example.com'));
  assert.match(avatarHash('dev@example.com'), /^[0-9a-f]{64}$/);
});

test('un commit sans adresse n’a pas d’empreinte d’avatar plutôt qu’une empreinte du vide', () => {
  // Sinon tous les auteurs sans adresse partageraient une même fausse photo.
  const [k] = parseLog(line('fff6', 'fff6', '', '', 'sans adresse', '1754200000', 'ok', ''));
  assert.equal(k.email, null);
  assert.equal(k.avatar, null);
  assert.equal(avatarHash(''), null);
  assert.equal(avatarHash(null), null);
});

test('un commit racine a une liste de parents vide, pas une entrée vide', () => {
  const [k] = parseLog(line('aaa1', 'aaa1', '', '', 'p', '1754200000', 'initial'));
  assert.deepEqual(k.parents, []);
});

test('les lignes qui ne commencent pas par le séparateur sont ignorées', () => {
  // Robustesse : une bannière ou une ligne vide en tête ne doit pas produire de faux commit.
  const raw = ['', 'warning: quelque chose', line('bbb2', 'bbb2', '', '', 'p', '1754200000', 'ok')].join('\n');
  const out = parseLog(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, 'bbb2');
});

test('un sujet contenant le séparateur ne décale pas les champs', () => {
  // Le sujet est pris en dernier et rejoint : c'est ce qui rend le découpage insensible à un
  // message biscornu, alors qu'un accès par index l'aurait tronqué.
  const [k] = parseLog(line('ccc3', 'ccc3', '', '', 'p', '1754200000', `avant${SEP}après`));
  assert.equal(k.subject, `avant${SEP}après`);
  assert.equal(k.author, 'p');
});

test('un horodatage absent ou nul ne devient pas une date de 1970', () => {
  const [vide] = parseLog(line('ddd4', 'ddd4', '', '', 'p', '', 'sans date'));
  const [zero] = parseLog(line('eee5', 'eee5', '', '', 'p', '0', 'epoch'));
  assert.equal(vide.at, null);
  assert.equal(zero.at, null);
});

test('la branche courante est reconnue comme la branche elle-même, pas comme « HEAD -> dev »', () => {
  // Sans ça la sidebar afficherait deux étiquettes pour une seule branche.
  const refs = parseRefs('HEAD -> dev, origin/dev, tag: v1.2');

  assert.deepEqual(refs, [
    { name: 'dev', kind: 'local', head: true },
    { name: 'origin/dev', kind: 'remote', head: false },
    { name: 'v1.2', kind: 'tag', head: false },
  ]);
});

test('un HEAD détaché est une ref à part entière', () => {
  assert.deepEqual(parseRefs('HEAD'), [{ name: 'HEAD', kind: 'head', head: true }]);
});

test('une décoration vide ne produit aucune ref', () => {
  assert.deepEqual(parseRefs(''), []);
  assert.deepEqual(parseRefs(null), []);
});

test('une branche locale sans barre oblique n’est pas prise pour une distante', () => {
  assert.deepEqual(parseRefs('main'), [{ name: 'main', kind: 'local', head: false }]);
});

test('status v2 donne la branche, son amont et l’écart', () => {
  const out = parseStatus(
    ['# branch.oid 378b612f8aa', '# branch.head dev', '# branch.upstream origin/dev', '# branch.ab +3 -2'].join('\n')
  );

  assert.equal(out.branch, 'dev');
  assert.equal(out.upstream, 'origin/dev');
  assert.equal(out.ahead, 3);
  assert.equal(out.behind, 2);
  assert.equal(out.dirty, 0);
});

test('les fichiers modifiés sont comptés, les en-têtes ne le sont pas', () => {
  const out = parseStatus(
    [
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb server.js',
      '1 A. N... 000000 100644 100644 000 ccc lib/git.js',
      '? public/brouillon.css',
    ].join('\n')
  );

  assert.equal(out.dirty, 3);
  assert.equal(out.branch, 'main');
});

test('un HEAD détaché est rapporté tel que git le nomme, pas en null', () => {
  assert.equal(parseStatus('# branch.head (detached)').branch, '(detached)');
});

test('un dépôt sans amont laisse l’écart à zéro sans inventer de valeur', () => {
  const out = parseStatus(['# branch.head dev', '# branch.upstream origin/dev'].join('\n'));
  assert.equal(out.ahead, 0);
  assert.equal(out.behind, 0);
});

test('la limite de commits reste dans ses bornes', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit('abc'), DEFAULT_LIMIT);
  assert.equal(clampLimit(0), DEFAULT_LIMIT);
  assert.equal(clampLimit(-5), DEFAULT_LIMIT);
  assert.equal(clampLimit('25'), 25);
  assert.equal(clampLimit(12.7), 12);
  assert.equal(clampLimit(10_000), MAX_LIMIT);
});

// --- Fraîcheur du clone ----------------------------------------------------
//
// Constaté sur un dépôt réel : le panneau affichait fidèlement un clone dont le dernier
// fetch datait de deux heures, et les commits poussés entre-temps étaient invisibles. Rien
// de faux à l'écran, mais on en concluait qu'il n'y avait rien de plus récent.

test("l'âge du fetch est null hors d'un dépôt", async () => {
  assert.equal(await git.fetchAge(os.tmpdir()), null);
});

test('un fetch sans distant reussit silencieusement, comme git lui-meme', async () => {
  // Verifie plutot que suppose : `git fetch` sans aucun distant sort en 0 sans rien faire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-nodistant-'));
  await run('git', ['init', '-q'], { cwd: dir });
  assert.deepEqual(await git.fetch(dir), { fetched: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("un distant injoignable ne lance pas, il explique", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-mauvais-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['remote', 'add', 'origin', '/inexistant/depot.git'], { cwd: dir });
  const done = await git.fetch(dir);
  assert.equal(done.fetched, false);
  assert.ok(done.reason, 'la raison est renvoyee pour etre affichee');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('le graphe rend compte de sa propre fraicheur', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-frais-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'x@y.z'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Essai'], { cwd: dir });
  await run('git', ['remote', 'add', 'origin', '/inexistant/depot.git'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'premier'], { cwd: dir });
  await run('git', ['update-ref', 'refs/remotes/origin/ailleurs', 'HEAD'], { cwd: dir });

  const data = await git.graph(dir);
  assert.equal(data.repo, true);
  assert.equal(data.all, true);
  assert.equal(data.rows.length, 1, 'le graphe reste utilisable malgre le fetch rate');
  assert.ok(
    data.rows[0].refs.some((ref) => ref.name === 'origin/ailleurs'),
    'une branche distante est incluse sans option a activer'
  );
  assert.ok(data.fetchFailed, 'et l echec est dit, au lieu de laisser croire a un clone a jour');
  fs.rmSync(dir, { recursive: true, force: true });
});
