'use strict';

// Recherche plein texte dans les journaux de conversation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const search = require('../lib/search');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-search-'));
const fileOf = (id) => path.join(DIR, `${id}.jsonl`);

function write(id, items) {
  fs.writeFileSync(fileOf(id), items.map((i) => `${JSON.stringify(i)}\n`).join(''));
}

const CONVS = [
  { id: 'c1', title: 'Déploiement' },
  { id: 'c2', title: 'Refonte CSS' },
];

write('c1', [
  { id: 'i1', kind: 'user', text: 'Pourquoi le certificat expire-t-il ?' },
  { id: 'i2', kind: 'tool', tool: 'Bash', input: { command: 'openssl x509 -noout -dates' } },
  { id: 'i3', kind: 'text', text: 'Le certificat arrive à échéance en octobre.' },
]);
write('c2', [{ id: 'j1', kind: 'text', text: 'Rien à voir avec le sujet.' }]);

test('un terme est retrouvé dans le texte comme dans les entrées d\'outil', () => {
  const { results } = search.search('certificat', CONVS, fileOf);
  assert.equal(results.length, 1);
  assert.equal(results[0].convId, 'c1');
  assert.equal(results[0].count, 2);

  const openssl = search.search('openssl', CONVS, fileOf);
  assert.equal(openssl.results[0].matches[0].itemId, 'i2');
});

test('la recherche ignore la casse et rend un extrait de contexte', () => {
  const { results } = search.search('CERTIFICAT', CONVS, fileOf);
  assert.match(results[0].matches[0].snippet, /certificat/i);
});

test('un extrait long est coupé avec des ellipses', () => {
  write('c3', [{ id: 'k1', kind: 'text', text: `${'a'.repeat(300)} aiguille ${'b'.repeat(300)}` }]);
  const convs = [...CONVS, { id: 'c3', title: 'Long' }];
  const { snippet } = search.search('aiguille', convs, fileOf).results[0].matches[0];
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.length < 200);
});

test('un terme trop court ne déclenche pas de balayage', () => {
  assert.deepEqual(search.search('a', CONVS, fileOf).results, []);
  assert.deepEqual(search.search('', CONVS, fileOf).results, []);
  assert.deepEqual(search.search('   ', CONVS, fileOf).results, []);
});

test('le résultat d\'un outil arrivé après coup est cherchable, et une seule fois', () => {
  write('c4', [
    { id: 'm1', kind: 'tool', tool: 'Read', input: { path: '/tmp/x' } },
    { id: 'm1', kind: 'tool', tool: 'Read', input: { path: '/tmp/x' }, result: 'mot-clé rare' },
  ]);
  const convs = [{ id: 'c4', title: 'Outil' }];
  const { results } = search.search('mot-clé rare', convs, fileOf);
  assert.equal(results[0].count, 1);
});

test('une conversation sans journal ne fait pas échouer la recherche', () => {
  const { results } = search.search('certificat', [...CONVS, { id: 'absente', title: '?' }], fileOf);
  assert.equal(results.length, 1);
});

test('le nombre d\'occurrences par conversation est borné, et le signale', () => {
  write('c5', Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, kind: 'text', text: 'répétition' })));
  const { results, truncated } = search.search('répétition', [{ id: 'c5', title: 'Bruit' }], fileOf);
  assert.equal(results[0].matches.length, search.MAX_MATCHES_PER_CONV);
  assert.equal(truncated, true);
});

test('un journal modifié est relu, pas servi depuis le cache', () => {
  write('c6', [{ id: 'p1', kind: 'text', text: 'avant' }]);
  const convs = [{ id: 'c6', title: 'Cache' }];
  assert.equal(search.search('avant', convs, fileOf).results.length, 1);

  write('c6', [{ id: 'p1', kind: 'text', text: 'après modification' }]);
  assert.equal(search.search('avant', convs, fileOf).results.length, 0);
  assert.equal(search.search('après', convs, fileOf).results.length, 1);
});

test('oublier une conversation la retire de la mémoire de recherche', () => {
  write('c7', [{ id: 'q1', kind: 'text', text: 'éphémère' }]);
  const convs = [{ id: 'c7', title: 'Supprimée' }];
  assert.equal(search.search('éphémère', convs, fileOf).results.length, 1);

  fs.rmSync(fileOf('c7'));
  search.forget('c7');
  assert.equal(search.search('éphémère', convs, fileOf).results.length, 0);
});

test('le cache LRU respecte son plafond sans tronquer les conversations trop grosses', () => {
  const bounded = search.createSearch({ maxCacheBytes: 500 });
  write('c8', [{ id: 'r1', kind: 'text', text: 'première conversation en cache' }]);
  write('c9', [{ id: 's1', kind: 'text', text: 'seconde conversation en cache' }]);

  assert.equal(
    bounded.search('première', [{ id: 'c8', title: 'Première' }], fileOf).results.length,
    1
  );
  assert.equal(
    bounded.search('seconde', [{ id: 'c9', title: 'Seconde' }], fileOf).results.length,
    1
  );
  assert.ok(bounded.cacheInfo().bytes <= bounded.cacheInfo().maxBytes);
  assert.equal(bounded.cacheInfo().conversations, 1, 'la moins récente doit être évincée');

  const uncached = search.createSearch({ maxCacheBytes: 1 });
  assert.equal(
    uncached.search('première', [{ id: 'c8', title: 'Première' }], fileOf).results.length,
    1,
    'dépasser le cache ne doit jamais retirer du contenu cherchable'
  );
  assert.deepEqual(uncached.cacheInfo(), { conversations: 0, bytes: 0, maxBytes: 1 });

  write('vide', []);
  const empty = search.createSearch({ maxCacheBytes: 500 });
  empty.search('absent', [{ id: 'vide', title: 'Vide' }], fileOf);
  assert.equal(empty.cacheInfo().conversations, 0, 'les journaux vides ne gonflent pas la Map');
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
