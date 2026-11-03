'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const drafts = require('../public/plan-drafts');

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test('un brouillon survit à une nouvelle instance et reconnaît sa base serveur', () => {
  const disk = storage();
  drafts.create({ storage: disk }).save({
    project: '/projet', path: 'docs/plans/a.md', base: 'version serveur', content: 'mon édition',
  });
  const reloaded = drafts.create({ storage: disk });
  const record = reloaded.load('/projet', 'docs/plans/a.md');
  assert.equal(record.content, 'mon édition');
  assert.equal(reloaded.relation(record, 'version serveur'), 'same-base');
  assert.equal(reloaded.relation(record, 'version modifiée ailleurs'), 'conflict');
});

test('un conflit ne détruit pas le brouillon tant que la personne ne tranche pas', () => {
  const disk = storage();
  const store = drafts.create({ storage: disk });
  store.save({ project: '/p', path: 'a.md', base: 'A', content: 'brouillon' });
  const record = store.load('/p', 'a.md');
  assert.equal(store.relation(record, 'B'), 'conflict');
  assert.equal(store.load('/p', 'a.md').content, 'brouillon');
  store.remove('/p', 'a.md');
  assert.equal(store.load('/p', 'a.md'), null);
});

test('les couples projet et chemin ambigus gardent des clés distinctes', () => {
  assert.notEqual(drafts.keyOf('/a.', 'b'), drafts.keyOf('/a', '.b'));
});

test('quota et taille maximale gardent un secours mémoire et signalent la non-persistance', () => {
  const reasons = [];
  const broken = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  const quota = drafts.create({ storage: broken, onWarning: (reason) => reasons.push(reason) });
  const result = quota.save({ project: '/p', path: 'quota.md', base: '', content: 'texte' });
  assert.equal(result.persisted, false);
  assert.equal(quota.load('/p', 'quota.md').content, 'texte');
  assert.equal(quota.load('/p', 'quota.md').persisted, false);
  assert.deepEqual(reasons, ['quota']);

  const small = drafts.create({ storage: storage(), maxChars: 4, onWarning: (reason) => reasons.push(reason) });
  const oversized = small.save({ project: '/p', path: 'long.md', base: '', content: '12345' });
  assert.equal(oversized.reason, 'too-large');
  assert.equal(small.load('/p', 'long.md').content, '12345');
  assert.equal(reasons.at(-1), 'too-large');
});

test('un stockage explicitement indisponible reste fonctionnel en mémoire', () => {
  const reasons = [];
  const store = drafts.create({ storage: null, onWarning: (reason) => reasons.push(reason) });
  const saved = store.save({ project: '/p', path: 'memory.md', base: 'A', content: 'édition' });
  assert.equal(saved.persisted, false);
  assert.equal(saved.reason, 'unavailable');
  assert.equal(store.load('/p', 'memory.md').content, 'édition');
  assert.deepEqual(reasons, ['unavailable']);
});

test('un échec de suppression ne ressuscite pas le brouillon dans le même onglet', () => {
  const reasons = [];
  const disk = storage();
  const store = drafts.create({ storage: disk, onWarning: (reason) => reasons.push(reason) });
  store.save({ project: '/p', path: 'a.md', base: 'A', content: 'édition' });
  disk.removeItem = () => { throw new Error('stockage verrouillé'); };
  assert.equal(store.remove('/p', 'a.md'), false);
  assert.equal(store.load('/p', 'a.md'), null);
  assert.deepEqual(reasons, ['remove']);
});
