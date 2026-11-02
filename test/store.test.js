'use strict';

// Persistance : journal d'items append-only, réécritures, et migration de l'ancien format.
//
// Le point à ne pas casser : un item ajouté ne doit plus coûter la taille du fil. Le
// second : un item modifié après coup — résultat d'outil, avis repeint en erreur — doit
// bien être celui qu'on relit, à sa place d'origine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-store-'));
process.env.AGENTHUB_DATA = DATA;

const store = require('../lib/store');

/**
 * Recharge le module : c'est la seule façon de vérifier ce qui a réellement atterri sur
 * disque. On flushe l'instance courante et non la première, sinon le travail fait sur une
 * instance rechargée ne serait jamais écrit.
 */
let current = store;
function reload() {
  current.flush();
  delete require.cache[require.resolve('../lib/store')];
  current = require('../lib/store');
  return current;
}

const NEW = { provider: 'claude', cwd: '/tmp', title: 'Essai' };

test('le dossier de projet est créé une fois, puis réutilisé', () => {
  const first = store.folderForCwd('/tmp/SampleApp');
  assert.equal(first.name, 'SampleApp', 'nommé par le dernier segment du chemin');
  assert.equal(store.folderForCwd('/tmp/SampleApp').id, first.id, 'pas de doublon');
  // Une barre oblique finale désigne le même projet.
  assert.equal(store.folderForCwd('/tmp/SampleApp/').id, first.id);
});

test('deux projets de même nom ne partagent pas de dossier', () => {
  // Rapprochement sur le chemin et non sur le nom : les confondre mélangerait deux
  // historiques sans moyen de les redémêler.
  const a = store.folderForCwd('/srv/client-a/site');
  const b = store.folderForCwd('/srv/client-b/site');
  assert.equal(a.name, 'site');
  assert.equal(b.name, 'site');
  assert.notEqual(a.id, b.id);
});

test("un dossier créé à la main n'est jamais réquisitionné", () => {
  const manual = store.createFolder('Perso');
  const auto = store.folderForCwd('/srv/Perso');
  assert.notEqual(auto.id, manual.id);
});

test('un chemin vide ne crée aucun dossier', () => {
  const before = store.folders().length;
  assert.equal(store.folderForCwd(''), null);
  assert.equal(store.folderForCwd(null), null);
  assert.equal(store.folders().length, before);
});

test('les items vont dans le journal, pas dans le fichier de métadonnées', () => {
  const conv = store.create(NEW);
  store.addItem(conv.id, { kind: 'user', text: 'bonjour' });
  store.addItem(conv.id, { kind: 'text', text: 'réponse' });
  store.flush();

  const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'conv', `${conv.id}.json`), 'utf8'));
  assert.equal(meta.items, undefined, 'le .json ne doit plus porter les items');
  assert.equal(meta.title, 'Essai');

  const lines = fs.readFileSync(store.itemsFile(conv.id), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, 'bonjour');
});

test('un item est relu identique après rechargement', () => {
  const conv = store.create(NEW);
  const item = store.addItem(conv.id, { kind: 'tool', tool: 'Bash', input: { command: 'ls' } });

  const fresh = reload();
  const again = fresh.get(conv.id);
  assert.equal(again.items.length, 1);
  assert.deepEqual(again.items[0], item);
});

test('un item modifié garde sa place et sa dernière version gagne', () => {
  const store2 = reload();
  const conv = store2.create(NEW);
  store2.addItem(conv.id, { kind: 'user', text: 'premier' });
  const tool = store2.addItem(conv.id, { kind: 'tool', tool: 'Read' });
  store2.addItem(conv.id, { kind: 'text', text: 'dernier' });

  // Le résultat de l'outil arrive après coup, comme dans un vrai turn.
  tool.result = 'contenu du fichier';
  tool.isError = false;
  store2.touchItem(conv.id, tool);

  const fresh = reload();
  const items = fresh.get(conv.id).items;
  assert.equal(items.length, 3, 'la réécriture ne doit pas dupliquer l\'item');
  assert.equal(items[1].id, tool.id, "l'item modifié reste à sa place d'origine");
  assert.equal(items[1].result, 'contenu du fichier');
  assert.equal(items[2].text, 'dernier');
});

test('une ligne tronquée par un crash ne fait pas perdre le reste du fil', () => {
  const store2 = reload();
  const conv = store2.create(NEW);
  store2.addItem(conv.id, { kind: 'text', text: 'avant' });
  fs.appendFileSync(store2.itemsFile(conv.id), '{"kind":"text","text":"tron');
  fs.appendFileSync(
    store2.itemsFile(conv.id),
    `\n${JSON.stringify({ id: 'z', kind: 'text', text: 'après' })}\n`
  );

  const items = reload().get(conv.id).items;
  assert.deepEqual(items.map((i) => i.text), ['avant', 'après']);
});

test("l'ancien format — items dans le .json — est migré à la lecture", () => {
  const store2 = reload();
  const conv = store2.create(NEW);
  const id = conv.id;
  store2.flush();

  // On réécrit le fichier tel qu'il était avant le passage au journal.
  const file = path.join(DATA, 'conv', `${id}.json`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.items = [
    { id: 'a', kind: 'user', text: 'ancien message' },
    { id: 'b', kind: 'text', text: 'ancienne réponse' },
  ];
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
  fs.rmSync(store2.itemsFile(id), { force: true });

  const fresh = reload();
  const migrated = fresh.get(id);
  assert.equal(migrated.items.length, 2);
  assert.equal(migrated.items[0].text, 'ancien message');

  // Et sur disque : journal créé, métadonnées allégées.
  assert.ok(fs.existsSync(fresh.itemsFile(id)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items, undefined);
});

test('supprimer une conversation emporte son journal', () => {
  const store2 = reload();
  const conv = store2.create(NEW);
  store2.addItem(conv.id, { kind: 'text', text: 'x' });
  store2.flush();
  assert.ok(fs.existsSync(store2.itemsFile(conv.id)));

  store2.remove(conv.id);
  assert.equal(fs.existsSync(store2.itemsFile(conv.id)), false);
  assert.equal(fs.existsSync(path.join(DATA, 'conv', `${conv.id}.json`)), false);
});

test('une conversation ayant des enfants ne se purge pas, mais se supprime à la main', () => {
  const store2 = reload();
  const parent = store2.create(NEW);
  const child = store2.create({ ...NEW, parentId: parent.id });

  assert.equal(store2.hasChildren(parent.id), true);
  assert.equal(store2.purge(parent.id), false);

  const detached = store2.remove(parent.id);
  assert.deepEqual(detached, [child.id]);
  assert.equal(store2.get(child.id).parentId, null, "l'enfant survit, détaché");
});

test('un dossier supprimé libère ses conversations sans les emporter', () => {
  const store2 = reload();
  const folder = store2.createFolder('Veille');
  const conv = store2.create({ ...NEW, folder: folder.id });

  store2.removeFolder(folder.id);
  assert.equal(store2.get(conv.id).folder, null);
  assert.ok(store2.list().some((c) => c.id === conv.id));
});

// L'ordre des dossiers. Il n'a pas de champ dédié : c'est l'ordre du tableau, donc ces tests
// vérifient surtout qu'on ne perd jamais un dossier en le réarrangeant — le seul dégât
// vraiment gênant, puisqu'il retirerait un rangement de la barre latérale.

// Les dossiers des tests précédents sont encore sur le disque : on compare donc des
// identifiants, jamais la liste entière, et on s'appuie sur le contrat — les dossiers cités
// passent devant, dans l'ordre demandé.

/** Les `n` premiers identifiants de la liste. */
const head = (folders, n) => folders.slice(0, n).map((f) => f.id);

test('réordonner met les dossiers cités devant, dans l’ordre demandé', () => {
  const s = reload();
  const a = s.createFolder('A');
  const b = s.createFolder('B');
  const c = s.createFolder('C');

  const out = s.reorderFolders([c.id, a.id, b.id]);
  assert.deepEqual(head(out, 3), [c.id, a.id, b.id]);
  assert.deepEqual(head(s.folders(), 3), [c.id, a.id, b.id], 'la lecture doit refléter l’ordre');
});

test('un dossier non cité reste dans la liste plutôt que de disparaître', () => {
  // Cas réel : un dossier de projet naît pendant qu'on glisse, le client ne le connaît pas.
  const s = reload();
  const a = s.createFolder('A');
  const b = s.createFolder('B');
  const surprise = s.createFolder('Surprise');
  const total = s.folders().length;

  const out = s.reorderFolders([b.id, a.id]);
  assert.deepEqual(head(out, 2), [b.id, a.id]);
  assert.ok(out.some((f) => f.id === surprise.id), 'aucun dossier ne doit être perdu');
  assert.equal(out.length, total, 'ni perdu, ni dupliqué');
});

test('les identifiants inconnus et les doublons sont ignorés', () => {
  const s = reload();
  const a = s.createFolder('A');
  const b = s.createFolder('B');
  const total = s.folders().length;

  const out = s.reorderFolders([b.id, 'fantome', b.id, a.id]);
  assert.deepEqual(head(out, 2), [b.id, a.id]);
  assert.equal(out.length, total, 'un doublon ne doit pas dupliquer le dossier');
  assert.equal(out.filter((f) => f.id === b.id).length, 1);
});

test('réordonner avec une liste vide ne change rien', () => {
  const s = reload();
  s.createFolder('A');
  s.createFolder('B');
  const before = s.folders().map((f) => f.id);

  assert.deepEqual(s.reorderFolders([]).map((f) => f.id), before);
  assert.deepEqual(s.reorderFolders(null).map((f) => f.id), before, 'une entrée absente non plus');
});

test("l'ordre survit à un rechargement depuis le disque", () => {
  const s = reload();
  const a = s.createFolder('A');
  const b = s.createFolder('B');
  s.reorderFolders([b.id, a.id]);

  const after = reload();
  assert.deepEqual(
    head(after.folders(), 2),
    [b.id, a.id],
    'sans ça, l’ordre choisi serait perdu au prochain redémarrage de PM2'
  );
});

// Le flush est différé de 400 ms : sans ce dernier vidage, un minuteur écrirait dans un
// dossier déjà supprimé.
test.after(() => {
  current.flush();
  fs.rmSync(DATA, { recursive: true, force: true });
});
