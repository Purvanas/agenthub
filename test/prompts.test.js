'use strict';

// Prompts enregistrés : des consignes à trous, réutilisables.
//
// Le point qui décide de tout : un trou non rempli reste visible dans le texte. L'effacer
// donnerait une phrase qui se lit bien et à qui il manque un mot, ce qui ne se voit pas.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-prompts-'));
process.env.AGENTHUB_DATA = DATA;

const prompts = require('../lib/prompts');

test.beforeEach(() => fs.rmSync(prompts.FILE, { force: true }));

test('les trous sortent dans l ordre du texte, sans doublon', () => {
  assert.deepEqual(
    prompts.holes('Déploie {{projet}} sur {{serveur}}, puis préviens sur {{projet}}.'),
    ['projet', 'serveur']
  );
  assert.deepEqual(prompts.holes('Aucun trou ici.'), []);
});

test('les espaces autour du nom d un trou sont tolerés', () => {
  assert.deepEqual(prompts.holes('{{ projet }}'), ['projet']);
  assert.equal(prompts.fill('{{ projet }}', { projet: 'agentHub' }), 'agentHub');
});

test('un modele se remplit, repetitions comprises', () => {
  const body = 'Relis {{branche}} et dis si {{branche}} peut fusionner.';
  assert.equal(
    prompts.fill(body, { branche: 'main' }),
    'Relis main et dis si main peut fusionner.'
  );
});

// Le cœur de la fonctionnalité. Un `{{projet}}` resté en clair se remarque ; une phrase
// amputée, non — et un agent lancé dessus part sur une consigne incomplète.
test('un trou sans valeur reste visible plutot que d etre efface', () => {
  const body = 'Prépare la mise en ligne de {{projet}}.';
  assert.equal(prompts.fill(body, {}), body);
  assert.equal(prompts.fill(body, { projet: '   ' }), body);
  assert.equal(prompts.fill(body, { autre: 'x' }), body);
});

test('le nombre de trous est borne', () => {
  const many = Array.from({ length: 30 }, (_, i) => `{{v${i}}}`).join(' ');
  assert.equal(prompts.holes(many).length, prompts.MAX_HOLES);
});

test('creer, relire, modifier, supprimer', () => {
  const row = prompts.create({ name: 'Revue', body: 'Relis {{cible}}.' });
  assert.deepEqual(row.holes, ['cible']);
  assert.equal(prompts.get(row.id).name, 'Revue');

  const changed = prompts.update(row.id, { body: 'Relis {{cible}} sur {{branche}}.' });
  assert.deepEqual(changed.holes, ['cible', 'branche']);
  assert.equal(changed.name, 'Revue');

  assert.equal(prompts.remove(row.id), true);
  assert.equal(prompts.remove(row.id), false);
  assert.equal(prompts.get(row.id), null);
});

test('un modele sans nom ou sans corps est refuse', () => {
  assert.throws(() => prompts.create({ name: '', body: 'x' }), /Nom vide/);
  assert.throws(() => prompts.create({ name: 'x', body: '  ' }), /Consigne vide/);
  const row = prompts.create({ name: 'ok', body: 'ok' });
  assert.throws(() => prompts.update(row.id, { name: '' }), /Nom vide/);
});

// Une liste par ordre de création devient un cimetière qu'on parcourt : ce qui sert souvent
// doit remonter.
test('le dernier employe passe en tete', () => {
  const a = prompts.create({ name: 'A', body: 'a' });
  const b = prompts.create({ name: 'B', body: 'b' });
  assert.deepEqual(prompts.list().map((p) => p.name), ['B', 'A']);

  const used = prompts.used(a.id);
  assert.equal(used.uses, 1);
  assert.deepEqual(prompts.list().map((p) => p.name), ['A', 'B']);
  assert.equal(prompts.used('inconnu'), null);
  // Le nom `b` reste intact : marquer un emploi ne touche à rien d'autre.
  assert.equal(prompts.get(b.id).body, 'b');
});
