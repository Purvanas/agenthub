'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const picker = require('../public/model-picker');

const catalog = {
  grok: [
    {
      value: '',
      label: 'Dernier modèle — Grok 4.7',
      note: 'Suit le défaut du compte.',
      efforts: [
        { value: '', label: 'Défaut du modèle' },
        { value: 'high', label: 'Élevé' },
      ],
    },
    {
      value: 'grok-4.7-build-fast',
      displayName: 'Grok 4.7 Fast',
      label: 'Grok 4.7 Fast — variante rapide, deux fois le prix',
      note: 'Variante plus rapide de la même génération.',
      fast: true,
      priceMultiplier: 2,
      efforts: [
        { value: '', label: 'Défaut du modèle' },
        { value: 'low', label: 'Faible' },
      ],
    },
    { value: 'grok-4.6', label: 'Grok 4.6 — ancienne version', note: 'Version encore servie.' },
  ],
  codex: [{ value: 'gpt-5.6-sol', label: 'gpt-5.6-sol — frontier agentique' }],
  efforts: {
    grok: [
      { value: '', label: 'Défaut du modèle' },
      { value: 'medium', label: 'Moyen' },
      { value: 'high', label: 'Élevé' },
    ],
    codex: [{ value: '', label: 'Défaut (faible)' }],
  },
  defaults: {
    grok: {
      model: 'grok-4.7',
      label: 'Dernier modèle — Grok 4.7',
      source: 'grok models',
      effort: 'high',
    },
    codex: { model: null, label: 'Défaut CLI — modèle non confirmé', source: 'unknown' },
  },
};

test('name préfère les noms structurés puis coupe la note après le tiret long', () => {
  assert.equal(picker.name('grok', 'grok-4.7-build-fast', catalog), 'Grok 4.7 Fast');
  assert.equal(picker.name('grok', 'grok-4.6', catalog), 'Grok 4.6');
  assert.equal(picker.name('codex', 'gpt-5.6-sol', catalog), 'gpt-5.6-sol');
  assert.equal(picker.name('grok', 'modele-inconnu', catalog), 'modele-inconnu');
});

test("effortOptions utilise d'abord les efforts propres au modèle", () => {
  assert.deepEqual(
    picker.effortOptions('grok', 'grok-4.7-build-fast', catalog).map((item) => item.value),
    ['', 'low']
  );
  assert.deepEqual(
    picker.effortOptions('grok', 'grok-4.6', catalog).map((item) => item.value),
    ['', 'medium', 'high']
  );
  assert.deepEqual(
    picker.effortOptions('grok', null, catalog).map((item) => item.value),
    ['', 'medium', 'high'],
    "un identifiant personnalisé utilise les efforts du fournisseur, pas ceux de l'entrée vide"
  );
});

test('describe rend le défaut résolu explicite sans le confondre avec une version figée', () => {
  assert.deepEqual(picker.describe('grok', '', '', catalog), {
    label: 'Défaut du CLI · actuellement Grok 4.7',
    detail: 'Suit le défaut du compte.',
    effortLabel: 'Défaut · actuellement Élevé',
  });
});

test('describe ne prétend pas connaître un défaut absent du catalogue', () => {
  assert.deepEqual(picker.describe('codex', '', '', catalog), {
    label: 'Défaut du CLI · modèle non confirmé',
    detail: '',
    effortLabel: 'Réglage du CLI',
  });
});

test('describe distingue le modèle rapide et son effort compatible', () => {
  assert.deepEqual(picker.describe('grok', 'grok-4.7-build-fast', 'low', catalog), {
    label: 'Grok 4.7 Fast',
    detail: 'Variante plus rapide de la même génération.',
    effortLabel: 'Faible',
  });
});

test('un identifiant personnalisé reste lisible et ne reçoit aucune supposition', () => {
  assert.deepEqual(picker.describe('grok', 'grok-futur', 'xhigh', catalog), {
    label: 'grok-futur',
    detail: 'Identifiant personnalisé transmis directement au CLI.',
    effortLabel: 'xhigh',
  });
});
