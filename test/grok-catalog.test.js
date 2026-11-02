'use strict';

// Le menu Grok ne doit plus être un relevé écrit à la main. La commande `grok models`
// dit le défaut du jour et les versions encore servies : l'entrée vide suit le défaut,
// chaque identifiant fige une version.

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../lib/grok-catalog');

const LISTING = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.6
  - grok-4.5
`;

function effort(id, label, description, isDefault) {
  return { id, value: id, label, description, default: Boolean(isDefault) };
}

const CACHE = {
  models: {
    'grok-4.7': {
      info: {
        name: 'Grok 4.7',
        description: "SpaceXAI's latest frontier model",
        reasoning_efforts: [
          effort('xhigh', 'Extra High', 'Maximum reasoning'),
          effort('high', 'High', 'Thorough reasoning', true),
          effort('medium', 'Medium', 'Faster'),
          effort('low', 'Low', 'Fastest'),
        ],
      },
    },
    'grok-4.7-build-fast': {
      info: {
        name: 'Grok 4.7 Fast',
        description: 'Fast variant. 2x the price.',
        reasoning_efforts: [
          effort('high', 'High', 'Thorough', true),
          effort('low', 'Low', 'Fastest'),
        ],
      },
    },
    'grok-4.5': {
      info: {
        name: 'Grok 4.5',
        reasoning_efforts: [
          effort('high', 'High', 'Highest', true),
          effort('medium', 'Medium', 'Balanced'),
          effort('low', 'Low', 'Quick'),
        ],
      },
    },
  },
};

test('le texte de grok models donne le défaut et les identifiants, sans le commentaire', () => {
  const parsed = catalog.parseListing(LISTING);
  assert.equal(parsed.defaultModel, 'grok-4.7');
  assert.deepEqual(parsed.ids, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
});

test('une sortie vide ou illisible ne fabrique pas un catalogue', () => {
  assert.equal(catalog.buildCatalog('You are logged in.\n', CACHE), null);
  assert.equal(catalog.buildCatalog('', null), null);
});

test("l'entrée vide suit le défaut, et chaque version servie est figée à part", () => {
  const built = catalog.buildCatalog(LISTING, CACHE);
  assert.equal(built.defaultModel, 'grok-4.7');

  const rolling = built.models[0];
  assert.equal(rolling.value, '');
  assert.equal(rolling.group, 'Actuel');
  assert.equal(rolling.label, 'Dernier modèle — Grok 4.7');

  const pinned = built.models.filter((model) => model.group === 'Encore desservis');
  assert.deepEqual(
    pinned.map((model) => model.value),
    ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']
  );
  assert.equal(pinned[0].label, 'Grok 4.7 — figé sur cette version');
  assert.equal(pinned[1].label, 'Grok 4.7 Fast — variante rapide, deux fois le prix');
  assert.equal(pinned[2].label, 'grok-4.6');
  assert.equal(pinned[3].label, 'Grok 4.5');
});

test("l'effort proposé dépend de la version : 4.7 a « très élevé », 4.5 non", () => {
  const built = catalog.buildCatalog(LISTING, CACHE);
  const values = (model) => model.efforts.map((effort) => effort.value);
  const byId = Object.fromEntries(built.models.map((model) => [model.value, model]));

  assert.deepEqual(values(byId['']), ['', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(values(byId['grok-4.5']), ['', 'low', 'medium', 'high']);
  assert.equal(byId[''].efforts.find((effort) => effort.value === 'xhigh').label, 'Très élevé');
  assert.deepEqual(
    built.efforts.map((effort) => effort.value),
    ['', 'low', 'medium', 'high', 'xhigh']
  );
});

test('sans le cache de noms, les identifiants restent proposés', () => {
  const built = catalog.buildCatalog(LISTING, null);
  assert.deepEqual(
    built.models.map((model) => model.value),
    ['', 'grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']
  );
  assert.equal(built.models[2].label, 'grok-4.7-build-fast — variante rapide, deux fois le prix');
});

test('une lecture ratée ne casse pas le menu, et on ne relance pas à chaque appel', () => {
  catalog.resetCache();
  let calls = 0;
  const opts = {
    now: () => 1_000_000,
    cacheFile: '/tmp/agenthub-grok-catalog-absent.json',
    run() {
      calls += 1;
      throw new Error('cli absent');
    },
  };
  assert.equal(catalog.current(opts), null);
  assert.equal(catalog.current(opts), null);
  assert.equal(calls, 1);

  opts.now = () => 1_000_000 + catalog.RETRY_MS + 1;
  opts.run = () => LISTING;
  opts.cache = CACHE;
  const live = catalog.current(opts);
  assert.equal(live.defaultModel, 'grok-4.7');
  assert.equal(catalog.current(opts), live);
  catalog.resetCache();
});
