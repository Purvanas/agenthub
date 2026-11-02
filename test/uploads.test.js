'use strict';

// Ce qu'on accepte de ranger sous data/uploads, et sous quel nom. Un .json qui
// passerait pour une image irait ensuite sur `--image` et ferait échouer le turn.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONV = '11111111-1111-4111-8111-111111111111';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-uploads-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/uploads')];
  return { uploads: require('../lib/uploads'), dir };
}

function dataUrl(mime, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('un json est enregistré comme texte, sous son nom', () => {
  const { uploads, dir } = fresh();
  const saved = uploads.save(CONV, [
    { name: 'fiche.json', dataUrl: dataUrl('application/json', '{"nom":"Marion"}') },
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'text');
  assert.equal(saved[0].name, 'fiche.json');
  assert.match(saved[0].url, /\.json$/);
  assert.equal(fs.readFileSync(saved[0].path, 'utf8'), '{"nom":"Marion"}');
  assert.ok(saved[0].path.startsWith(path.join(dir, 'uploads', CONV)));
});

test('un markdown dont le navigateur ne donne pas de type passe quand même', () => {
  const { uploads } = fresh();
  const saved = uploads.save(CONV, [
    { name: 'brief.md', dataUrl: dataUrl('application/octet-stream', '# Brief\n\nÀ faire.') },
  ]);
  assert.equal(saved[0].kind, 'text');
  assert.match(saved[0].path, /\.md$/);
  assert.equal(fs.readFileSync(saved[0].path, 'utf8'), '# Brief\n\nÀ faire.');
});

test("l'extension .markdown est rangée en .md, le nom d'origine reste", () => {
  const { uploads } = fresh();
  const saved = uploads.save(CONV, [
    { name: 'spec.markdown', dataUrl: dataUrl('text/markdown;charset=utf-8', 'salut') },
  ]);
  assert.equal(saved[0].name, 'spec.markdown');
  assert.match(saved[0].url, /\.md$/);
});

test('une image png suit le chemin d’avant', () => {
  const { uploads } = fresh();
  const saved = uploads.save(CONV, [{ name: 'carre.png', dataUrl: PIXEL }]);
  assert.equal(saved[0].kind, 'image');
  assert.match(saved[0].url, /\.png$/);
  assert.ok(saved[0].bytes > 0);
});

test('un svg, un pdf et un binaire renommé en json sont refusés', () => {
  const { uploads } = fresh();
  assert.throws(
    () => uploads.save(CONV, [{ name: 'logo.svg', dataUrl: dataUrl('image/svg+xml', '<svg></svg>') }]),
    /non pris en charge/
  );
  assert.throws(
    () => uploads.save(CONV, [{ name: 'doc.pdf', dataUrl: dataUrl('application/pdf', '%PDF') }]),
    /non pris en charge/
  );
  assert.throws(
    () =>
      uploads.save(CONV, [
        { name: 'piege.json', dataUrl: dataUrl('application/json', Buffer.from('ok\0non')) },
      ]),
    /pas un fichier texte/
  );
  assert.throws(
    () =>
      uploads.save(CONV, [
        { name: 'casse.md', dataUrl: dataUrl('text/markdown', Buffer.from([0xff, 0xfe, 0xfd])) },
      ]),
    /UTF-8/
  );
});

test("un fichier refusé n'abandonne pas les précédents sur le disque", () => {
  const { uploads, dir } = fresh();
  assert.throws(() =>
    uploads.save(CONV, [
      { name: 'ok.json', dataUrl: dataUrl('application/json', '{}') },
      { name: 'non.pdf', dataUrl: dataUrl('application/pdf', '%PDF') },
    ])
  );
  const folder = path.join(dir, 'uploads', CONV);
  const left = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  assert.deepEqual(left, []);
});

test('un texte de plus de 2 Mo est refusé, le nom long garde son extension', () => {
  const { uploads } = fresh();
  const big = Buffer.alloc(uploads.MAX_TEXT_BYTES + 1, 0x61);
  assert.throws(
    () => uploads.save(CONV, [{ name: 'gros.json', dataUrl: dataUrl('application/json', big) }]),
    /2 Mo maximum/
  );

  const name = `${'a'.repeat(100)}.json`;
  const saved = uploads.save(CONV, [{ name, dataUrl: dataUrl('application/json', '{}') }]);
  assert.ok(saved[0].name.endsWith('.json'));
  assert.ok(saved[0].name.length <= 80);
});
