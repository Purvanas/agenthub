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

test('un identifiant ne peut ni lire ni effacer un fichier hors du dossier conv', () => {
  // Ces fichiers restent dans le DATA temporaire du test : rien hors sandbox n'est touché.
  const outsideMeta = path.join(DATA, 'outside.json');
  const outsideItems = path.join(DATA, 'outside.jsonl');
  fs.writeFileSync(outsideMeta, JSON.stringify({ id: '../outside', title: 'secret', items: [] }));
  fs.writeFileSync(outsideItems, `${JSON.stringify({ id: 'x', text: 'secret' })}\n`);

  for (const malicious of ['../outside', '..\\outside', '/outside', 'a/b', 'a%2Fb']) {
    assert.equal(store.get(malicious), null);
    assert.deepEqual(store.remove(malicious), []);
    assert.equal(store.purge(malicious), false);
    assert.throws(
      () => store.itemsFile(malicious),
      (err) => err && err.status === 400 && err.code === 'INVALID_CONVERSATION_ID'
    );
  }

  assert.equal(fs.readFileSync(outsideMeta, 'utf8').includes('secret'), true);
  assert.equal(fs.readFileSync(outsideItems, 'utf8').includes('secret'), true);
  assert.match(store.itemsFile('c1'), /c1\.jsonl$/);
  assert.match(store.itemsFile('atelier-skills'), /atelier-skills\.jsonl$/);
});

test('le dossier de projet est créé une fois, puis réutilisé', () => {
  const first = store.folderForCwd('/srv/projects/MyApp');
  assert.equal(first.name, 'MyApp', 'nommé par le dernier segment du chemin');
  assert.equal(store.folderForCwd('/srv/projects/MyApp').id, first.id, 'pas de doublon');
  // Une barre oblique finale désigne le même projet.
  assert.equal(store.folderForCwd('/srv/projects/MyApp/').id, first.id);
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

test('le cache faible conserve la même référence tant qu’elle est utilisée', () => {
  const conv = store.create(NEW);
  conv.queue = [{ id: 'q1', text: 'à garder' }];
  const meta = store.updateMeta(conv.id, { title: 'Titre léger' });
  assert.equal(meta.items, undefined);
  assert.deepEqual(conv.queue, [{ id: 'q1', text: 'à garder' }]);
  assert.equal(conv.title, 'Titre léger');
  assert.strictEqual(store.get(conv.id), conv);
  store.flush();
  assert.strictEqual(store.get(conv.id), conv);
});

test('un flush partiellement en échec conserve chaque écriture à rejouer', () => {
  const s = store;
  const first = s.create({ ...NEW, title: 'Premier' });
  const second = s.create({ ...NEW, title: 'Second' });
  const firstFile = path.join(DATA, 'conv', `${first.id}.json`);
  const secondFile = path.join(DATA, 'conv', `${second.id}.json`);
  const indexFile = path.join(DATA, 'index.json');

  const realRename = fs.renameSync;
  const realError = console.error;
  let failFirst = true;
  let failIndex = true;
  fs.renameSync = (from, to) => {
    if (failFirst && to === firstFile) {
      failFirst = false;
      throw new Error('échec conversation simulé');
    }
    if (failIndex && to === indexFile) {
      failIndex = false;
      throw new Error('échec index simulé');
    }
    return realRename(from, to);
  };
  console.error = () => {};
  try {
    assert.equal(s.flush(), false);
  } finally {
    fs.renameSync = realRename;
    console.error = realError;
  }

  assert.equal(fs.existsSync(firstFile), false, 'la conversation en échec reste en attente');
  assert.equal(fs.existsSync(secondFile), true, 'une erreur ne bloque pas les suivantes');
  assert.equal(s.flush(), true, 'le flush suivant rejoue conversation et index');
  assert.equal(fs.existsSync(firstFile), true);
  assert.ok(JSON.parse(fs.readFileSync(indexFile, 'utf8')).conversations.some((c) => c.id === first.id));
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

test('ouvrir un journal très révisé ne le réécrit pas et garde la dernière version', () => {
  const s = reload();
  const conv = s.create(NEW);
  const item = s.addItem(conv.id, { kind: 'tool', tool: 'Read', result: 'initial' });
  for (let n = 0; n < 70; n += 1) {
    item.result = `version ${n}`;
    s.touchItem(conv.id, item);
  }
  const before = fs.readFileSync(s.itemsFile(conv.id), 'utf8');
  const fresh = reload();
  assert.equal(fresh.get(conv.id).items[0].result, 'version 69');
  assert.equal(fs.readFileSync(s.itemsFile(conv.id), 'utf8'), before);
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

test('un nouvel item après une dernière ligne tronquée reste lisible', () => {
  const s = reload();
  const conv = s.create(NEW);
  s.addItem(conv.id, { kind: 'text', text: 'avant' });
  fs.appendFileSync(s.itemsFile(conv.id), '{"id":"cassé"');
  const afterCrash = reload();
  afterCrash.addItem(conv.id, { kind: 'text', text: 'sauvé' });
  assert.deepEqual(reload().get(conv.id).items.map((item) => item.text), ['avant', 'sauvé']);
});

test('getMeta ne lit pas le journal et expose projet et archivage', () => {
  const s = reload();
  const conv = s.create(NEW);
  s.update(conv.id, { archived: true, worktree: { repo: '/srv/repo', path: '/tmp/wt', branch: 'x' } });
  s.addItem(conv.id, { kind: 'text', text: 'contenu' });
  s.flush();
  const fresh = reload();
  const journal = fresh.itemsFile(conv.id);
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === journal) throw new Error('le journal ne devait pas être lu');
    return realRead(file, ...args);
  };
  try {
    const meta = fresh.getMeta(conv.id);
    assert.equal(meta.items, undefined);
    assert.equal(meta.archived, true);
    assert.equal(meta.project, '/srv/repo');
    const entry = fresh.list().find((candidate) => candidate.id === conv.id);
    assert.equal(entry.project, '/srv/repo');
    assert.equal(entry.archived, true);
    const updated = fresh.updateMeta(conv.id, { status: 'idle', title: 'Sans journal', items: ['interdit'] });
    assert.equal(updated.status, 'idle');
    assert.equal(updated.title, 'Sans journal');
    assert.equal(updated.items, undefined);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.deepEqual(fresh.get(conv.id).items.map((item) => item.text), ['contenu']);
});

test("l'index ancien retrouve le dépôt principal d'un worktree sans lire le journal", () => {
  const s = reload();
  const conv = s.create(NEW);
  s.update(conv.id, {
    cwd: '/srv/repo/data/worktrees/branche-test',
    worktree: { repo: '/srv/repo', path: '/srv/repo/data/worktrees/branche-test', branch: 'agent/test' },
    privateToken: 'ne doit jamais rejoindre la sidebar',
  });
  s.addItem(conv.id, { kind: 'text', text: 'journal lourd simulé' });
  s.flush();

  const indexFile = path.join(DATA, 'index.json');
  const legacy = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const oldEntry = legacy.conversations.find((entry) => entry.id === conv.id);
  delete oldEntry.project;
  fs.writeFileSync(indexFile, JSON.stringify(legacy, null, 2));

  delete require.cache[require.resolve('../lib/store')];
  const realRead = fs.readFileSync;
  const journal = path.join(DATA, 'conv', `${conv.id}.jsonl`);
  const metaFile = path.join(DATA, 'conv', `${conv.id}.json`);
  let metaReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === journal) throw new Error('le journal ne devait pas être lu');
    if (file === metaFile) metaReads += 1;
    return realRead(file, ...args);
  };
  try {
    current = require('../lib/store');
    const entry = current.list().find((candidate) => candidate.id === conv.id);
    assert.equal(entry.project, '/srv/repo');
    assert.equal(entry.privateToken, undefined);
    current.list();
    assert.equal(metaReads, 1, 'la migration est mise en cache après le premier list()');
  } finally {
    fs.readFileSync = realRead;
  }

  current.flush();
  const migrated = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(migrated.conversations.find((entry) => entry.id === conv.id).project, '/srv/repo');
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

test('un JSON corrompu est signalé au lieu d’être pris pour une conversation absente', () => {
  const s = reload();
  const conv = s.create(NEW);
  s.flush();
  const file = path.join(DATA, 'conv', `${conv.id}.json`);
  const valid = fs.readFileSync(file, 'utf8');

  const fresh = reload();
  fs.writeFileSync(file, '{"id":');
  assert.throws(() => fresh.get(conv.id), /lecture JSON impossible/);

  // Le fichier n'a pas été écrasé par un fallback vide et reste récupérable.
  fs.writeFileSync(file, valid);
  assert.equal(fresh.get(conv.id).id, conv.id);
});

test('une erreur de lecture du journal est signalée au lieu de produire un faux fil vide', () => {
  const s = reload();
  const conv = s.create(NEW);
  s.addItem(conv.id, { kind: 'text', text: 'à préserver' });
  s.flush();
  const fresh = reload();
  const journal = fresh.itemsFile(conv.id);
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === journal) {
      const err = new Error('permission refusée simulée');
      err.code = 'EACCES';
      throw err;
    }
    return realRead(file, ...args);
  };
  try {
    assert.throws(() => fresh.get(conv.id), /lecture du journal impossible/);
  } finally {
    fs.readFileSync = realRead;
  }
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

test('détacher ou libérer un fil ancien ne relit jamais son gros journal', () => {
  let s = reload();
  const folder = s.createFolder('À retirer');
  const parent = s.create(NEW);
  const child = s.create({ ...NEW, parentId: parent.id, folder: folder.id });
  s.addItem(child.id, { kind: 'text', text: 'contenu lourd simulé' });
  s.flush();
  s = reload(); // aucun objet conversation ne reste dans le cache de cette instance

  const journal = s.itemsFile(child.id);
  const realRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === journal) throw new Error('le journal ne devait pas être lu');
    return realRead(file, ...args);
  };
  try {
    assert.deepEqual(s.remove(parent.id), [child.id]);
    s.removeFolder(folder.id);
  } finally {
    fs.readFileSync = realRead;
  }

  s.flush();
  s = reload();
  const meta = s.getMeta(child.id);
  assert.equal(meta.parentId, null);
  assert.equal(meta.folder, null);
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
