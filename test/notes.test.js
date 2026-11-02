'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-notes-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/notes')];
  delete require.cache[require.resolve('../lib/uploads')];
  return { notes: require('../lib/notes'), dir };
}

// Un PNG d'un pixel : de quoi exercer le vrai chemin d'écriture des images.
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('un ticket naît à faire et se retrouve par projet', () => {
  const { notes } = fresh();
  const t = notes.create('/tmp/projet', { title: 'Refondre le hero', body: 'trop charge' });
  assert.equal(t.status, 'todo');
  assert.equal(t.project, '/tmp/projet');
  assert.deepEqual(notes.list('/tmp/projet').map((x) => x.id), [t.id]);
  assert.deepEqual(notes.list('/tmp/autre'), []);
});

test('la barre finale ne fait pas deux projets', () => {
  const { notes } = fresh();
  notes.create('/tmp/projet', { title: 'A' });
  // Le chemin arrive tantôt du dossier choisi, tantôt d'un dépôt git : les deux formes
  // doivent tomber sur la même liste.
  assert.equal(notes.list('/tmp/projet/').length, 1);
  assert.equal(notes.key('/tmp/projet/'), '/tmp/projet');
});

test('une conversation isolee partage le bloc-notes du depot principal', () => {
  const { notes } = fresh();
  const t = notes.create('/tmp/projet', { title: 'A' });
  const isolee = {
    cwd: './data/worktrees/abc',
    worktree: { repo: '/tmp/projet', branch: 'agenthub/abc' },
  };
  // Sinon une idée notée depuis une branche disparaîtrait avec elle.
  assert.equal(notes.projectOf(isolee), '/tmp/projet');
  assert.deepEqual(notes.list(notes.projectOf(isolee)).map((x) => x.id), [t.id]);
  assert.equal(notes.projectOf({ cwd: '/tmp/projet' }), '/tmp/projet');
  assert.equal(notes.projectOf(null), null);
});

test('un ticket sans titre est refuse', () => {
  const { notes } = fresh();
  assert.throws(() => notes.create('/p', { body: 'du detail' }), /Titre manquant/);
  assert.throws(() => notes.create('', { title: 'A' }), /Projet manquant/);
});

test('seuls les champs fournis changent', () => {
  const { notes } = fresh();
  const t = notes.create('/p', { title: 'Titre', body: 'Description' });
  // C'est ce qui permet à un agent de ne poster qu'un `{status}`.
  const moved = notes.update(t.id, { status: 'doing' });
  assert.equal(moved.status, 'doing');
  assert.equal(moved.title, 'Titre');
  assert.equal(moved.body, 'Description');
  assert.ok(moved.updatedAt >= t.updatedAt);
});

test('un etat inconnu est refuse avec les etats attendus', () => {
  const { notes } = fresh();
  const t = notes.create('/p', { title: 'A' });
  assert.throws(() => notes.update(t.id, { status: 'en-cours' }), /todo, doing, done/);
  assert.equal(notes.get(t.id).status, 'todo');
});

test('les tickets se rangent par etat puis par fraicheur', () => {
  const { notes } = fresh();
  const a = notes.create('/p', { title: 'A' });
  const b = notes.create('/p', { title: 'B' });
  const c = notes.create('/p', { title: 'C' });
  notes.update(a.id, { status: 'done' });
  notes.update(b.id, { status: 'doing' });
  assert.deepEqual(
    notes.list('/p').map((t) => t.title),
    ['C', 'B', 'A']
  );
});

test('les images sont ecrites et emportees par la suppression', () => {
  const { notes, dir } = fresh();
  const t = notes.create('/p', { title: 'Avec capture', images: [{ name: 'x.png', dataUrl: PIXEL }] });
  assert.equal(t.images.length, 1);
  assert.match(t.images[0].url, new RegExp(`^/uploads/${t.id}/`));

  const folder = path.join(dir, 'uploads', t.id);
  assert.equal(fs.readdirSync(folder).length, 1);
  assert.equal(notes.remove(t.id), true);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(notes.get(t.id), null);
});

test('une image ajoutee plus tard s ajoute aux precedentes', () => {
  const { notes } = fresh();
  const t = notes.create('/p', { title: 'A', images: [{ name: 'un.png', dataUrl: PIXEL }] });
  const after = notes.update(t.id, { images: [{ name: 'deux.png', dataUrl: PIXEL }] });
  assert.deepEqual(after.images.map((i) => i.name), ['un.png', 'deux.png']);
});

test('le prompt d un ticket porte son identifiant', () => {
  const { notes } = fresh();
  const t = notes.create('/p', { title: 'Refondre le hero', body: 'Trop charge.' });
  const text = notes.promptText(t);
  assert.match(text, /Refondre le hero/);
  assert.match(text, /Trop charge\./);
  // Sans l'identifiant, l'agent ne peut pas passer le bon ticket en « fait ».
  assert.match(text, new RegExp(t.id));
});

test('la convention d idee est toujours donnee, la liste seulement s il y a des tickets', () => {
  const { notes } = fresh();
  // C'est sur un projet vierge qu'on brainstorme le plus : le marqueur doit être connu
  // avant qu'un seul ticket existe.
  const vide = notes.promptBlock('/p');
  assert.match(vide, /\[idée\]/);
  assert.doesNotMatch(vide, /Bloc-notes du projet/);

  const t = notes.create('/p', { title: 'Refondre le hero' });
  const plein = notes.promptBlock('/p');
  assert.match(plein, /\[idée\]/);
  assert.match(plein, /Refondre le hero/);

  // Un projet dont tout est fait ne paie plus la liste, mais garde la convention.
  notes.update(t.id, { status: 'done' });
  const fait = notes.promptBlock('/p');
  assert.doesNotMatch(fait, /Refondre le hero/);
  assert.match(fait, /\[idée\]/);
});

test('la mise en garde ferme le bloc dans les deux cas', () => {
  const { notes } = fresh();
  // Elle doit être la dernière chose lue, avec ou sans liste de tickets.
  assert.match(notes.promptBlock('/p').trimEnd(), /ne la recopie jamais dans ta reponse\.$/);
  notes.create('/p', { title: 'A' });
  assert.match(notes.promptBlock('/p').trimEnd(), /ne la recopie jamais dans ta reponse\.$/);
});

test('le bloc de prompt retient l agent de travailler sans demande', () => {
  const { notes } = fresh();
  notes.create('/p', { title: 'Refondre le hero' });
  const block = notes.promptBlock('/p');
  // Un agent en autonomie totale qui voit une liste de tâches s'y mettrait tout seul.
  assert.match(block, /que si on te le demande/);
  assert.match(block, /AGENTHUB_NOTES_URL/);
  assert.match(block, /ne la recopie jamais/);
});

test('le bloc de prompt est borne et dit ce qu il ne montre pas', () => {
  const { notes } = fresh();
  for (let i = 0; i < notes.MAX_IN_PROMPT + 3; i += 1) notes.create('/p', { title: `T${i}` });
  const block = notes.promptBlock('/p');
  assert.equal(block.split('\n').filter((l) => l.startsWith('- [')).length, notes.MAX_IN_PROMPT);
  assert.match(block, /3 autre\(s\)/);
});

test('oublier un projet ne touche pas les autres', () => {
  const { notes } = fresh();
  notes.create('/p1', { title: 'A' });
  notes.create('/p1', { title: 'B' });
  notes.create('/p2', { title: 'C' });
  assert.equal(notes.forgetProject('/p1'), 2);
  assert.deepEqual(notes.list('/p2').map((t) => t.title), ['C']);
});
