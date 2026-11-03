'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SearchService } = require('../lib/search-service');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-persistent-index-'));
const CONV = path.join(DIR, 'conv');
const INDEXES = path.join(DIR, 'indexes');
fs.mkdirSync(CONV, { recursive: true });
const fileOf = (id) => path.join(CONV, `${id}.jsonl`);
const write = (id, items) => fs.writeFileSync(fileOf(id), items.map((item) => `${JSON.stringify(item)}\n`).join(''));
const append = (id, item) => fs.appendFileSync(fileOf(id), `${JSON.stringify(item)}\n`);
let service = new SearchService({ fileOf, indexDir: INDEXES });

const base = [
  { id: 'u1', kind: 'user', ts: '2026-01-01T10:00:00.000Z', text: 'Vérifie le certificat Éphémère' },
  { id: 't1', kind: 'tool', ts: '2026-01-01T10:01:00.000Z', tool: 'Read', input: { path: '/srv/app/config.js' } },
  { id: 'a1', kind: 'text', ts: '2026-01-01T10:02:00.000Z', text: 'Le certificat est encore valide.' },
];
write('c1', base);

test('la page lit les offsets indexés et respecte les fenêtres', async () => {
  const tail = await service.page('c1', { limit: 2 });
  assert.deepEqual(tail.items.map((item) => item.id), ['t1', 'a1']);
  assert.equal(tail.page.total, 3);
  assert.equal(tail.page.hasMore, true);

  const before = await service.page('c1', { limit: 2, before: 'a1' });
  assert.deepEqual(before.items.map((item) => item.id), ['u1', 't1']);
  const focus = await service.page('c1', { limit: 3, focus: 't1' });
  assert.deepEqual(focus.items.map((item) => item.id), ['u1', 't1', 'a1']);
});

test('une révision garde sa position, met à jour recherche et résultat complet', async () => {
  append('c1', { ...base[1], result: `Résultat CERTIFICAT Éphémère ${'x'.repeat(7000)}` });
  const page = await service.page('c1', { limit: 3 });
  assert.deepEqual(page.items.map((item) => item.id), ['u1', 't1', 'a1']);
  assert.equal(page.items[1].resultTruncated, true);
  assert.equal(page.items[1].result.length, 6000);

  const full = await service.result('c1', 't1');
  assert.equal(full.found, true);
  assert.ok(full.result.length > 7000);
  const found = await service.search('certificat éphémère', [{ id: 'c1', title: 'Certificat' }]);
  assert.equal(found.results[0].convId, 'c1');
  assert.ok(found.results[0].count >= 1);
});

test('l’index survit au redémarrage du service et s’incrémente sur append', async () => {
  await service.close();
  service = new SearchService({ fileOf, indexDir: INDEXES });
  assert.deepEqual((await service.page('c1', { limit: 3 })).items.map((item) => item.id), ['u1', 't1', 'a1']);
  append('c1', { id: 'a2', kind: 'text', ts: '2026-01-01T10:03:00.000Z', text: 'Nouvelle réponse' });
  assert.deepEqual((await service.page('c1', { limit: 2 })).items.map((item) => item.id), ['a1', 'a2']);
});

test('une troncature ou réécriture reconstruit seulement la conversation', async () => {
  write('c1', [
    { id: 'n1', kind: 'user', ts: '2026-02-01T10:00:00.000Z', text: 'Nouveau journal' },
    { id: 'n2', kind: 'text', ts: '2026-02-01T10:01:00.000Z', text: 'Nouvelle histoire' },
  ]);
  const page = await service.page('c1', { limit: 10 });
  assert.deepEqual(page.items.map((item) => item.id), ['n1', 'n2']);
  assert.equal(page.page.total, 2);
  assert.equal((await service.search('certificat', [{ id: 'c1', title: 'Réécrit' }])).results.length, 0);
  assert.equal((await service.search('NOUVELLE histoire', [{ id: 'c1', title: 'Réécrit' }])).results.length, 1);
});

test('une ligne finale tronquée est ignorée sans avaler l’item suivant', async () => {
  fs.appendFileSync(fileOf('c1'), '{"id":"cassé"');
  assert.equal((await service.page('c1')).page.total, 2);
  fs.appendFileSync(fileOf('c1'), `\n${JSON.stringify({ id: 'n3', kind: 'text', text: 'après le crash' })}\n`);
  const page = await service.page('c1', { limit: 10 });
  assert.deepEqual(page.items.map((item) => item.id), ['n1', 'n2', 'n3']);
});

test('les filtres kind et dates s’appliquent sans changer le contrat de recherche', async () => {
  const convs = [{ id: 'c1', title: 'Filtres' }];
  assert.equal((await service.search('nouveau', convs, { kind: 'user' })).results.length, 1);
  assert.equal((await service.search('nouvelle', convs, { kind: 'user' })).results.length, 0);
  assert.equal((await service.search('nouvelle', convs, { kind: 'text', from: '2026-02-01T10:00:30.000Z' })).results.length, 1);
  assert.equal((await service.search('nouvelle', convs, { kind: 'text', to: '2026-02-01' })).results.length, 1);
});

test('les repères ont une forme stable, bornée et sans résumé inventé', async () => {
  append('c1', { id: 'tool-file', kind: 'tool', tool: 'Edit', input: { params: { files: ['/srv/app/main.js'] } } });
  append('c1', { id: 'latest', kind: 'text', ts: '2026-02-01T10:03:00.000Z', text: 'Dernière réponse utile' });
  const marks = await service.landmarks('c1');
  assert.deepEqual(Object.keys(marks).sort(), ['files', 'latest', 'totalItems', 'totalTurns', 'turns']);
  assert.equal(marks.turns[0].id, 'n1');
  assert.equal(marks.files[0].path, '/srv/app/main.js');
  assert.equal(marks.latest.id, 'latest');
  assert.equal(marks.latest.text, 'Dernière réponse utile');
  assert.equal(marks.totalTurns, 1);
  assert.equal((await service.search('/srv/app/main.js', [{ id: 'c1', title: 'Fichier' }])).results.length, 1);
});

test('un terme trop court ne démarre pas le worker', async () => {
  const isolated = new SearchService({ fileOf, indexDir: path.join(DIR, 'unused') });
  assert.deepEqual(await isolated.search('a', [{ id: 'c1', title: 'Court' }]), { term: 'a', results: [], truncated: false });
  assert.equal(isolated.worker, null);
  await isolated.close();
});

test.after(async () => {
  await service.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});
