'use strict';

// Courses asynchrones du front. Les blocs testés sont extraits d'app.js et exécutés dans une
// petite fenêtre VM : le test suit donc l'implémentation réellement livrée sans recopier sa
// logique dans une fonction de test plus facile à faire passer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = APP.indexOf(startMarker);
  const end = APP.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `bloc app.js extractible : ${startMarker}`);
  return APP.slice(start, end);
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('file : une lecture de fichier terminée après navigation conserve le fil du clic initial', async () => {
  const listenerSource = extract(
    "queueFileInput.addEventListener('change', async (e) => {",
    '\n\n// Réordonnancement par glisser-déposer'
  );
  const calls = [];
  const readers = [];
  const sandbox = {
    initialTarget: { convId: 'conversation-a', queueId: 'message-1' },
    state: { currentId: 'conversation-a' },
    calls,
    readers,
  };

  vm.runInContext(
    `
      let queueImageTarget = initialTarget;
      let changeHandler = null;
      const queueFileInput = {
        addEventListener(type, handler) {
          if (type === 'change') changeHandler = handler;
        },
      };
      class FileReader {
        constructor() {
          this.result = null;
          this.onload = null;
          this.onerror = null;
          readers.push(this);
        }
        readAsDataURL(file) { this.file = file; }
      }
      const queueApi = async (...args) => { calls.push(args); return {}; };
      const toastError = (message) => { throw new Error(message); };
      ${listenerSource}
      runChange = (event) => changeHandler(event);
    `,
    vm.createContext(sandbox),
    { filename: 'app.queue-file-reader.vm.js' }
  );

  const input = { files: [{ name: 'capture.png' }], value: 'capture.png' };
  const pending = sandbox.runChange({ target: input });
  assert.equal(sandbox.readers.length, 1);
  assert.equal(input.value, '');

  // L'utilisateur ouvre B pendant que FileReader travaille encore sur la PJ choisie dans A.
  sandbox.state.currentId = 'conversation-b';
  sandbox.readers[0].result = 'data:image/png;base64,QQ==';
  sandbox.readers[0].onload();
  await pending;

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'PATCH');
  assert.equal(calls[0][1], '/message-1');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), {
    addImages: [{ name: 'capture.png', dataUrl: 'data:image/png;base64,QQ==' }],
  });
  assert.equal(calls[0][3], 'conversation-a');
});

test('surveillance : un tick lent ne se chevauche pas et une fermeture ignore son blob tardif', async () => {
  const watchSource = extract(
    'let watchTimer = null;',
    "\n$('#btn-watch').addEventListener('click', openWatch);"
  );
  const pendingFetches = [];
  const objectUrls = [];
  const revoked = [];
  const elements = {
    '#watch-modal': {
      classList: { add() {}, remove() {} },
    },
    '#watch-state': { textContent: '' },
    '#watch-url': { textContent: '', title: '' },
    '#watch-img': {
      src: '',
      removeAttribute(name) { if (name === 'src') this.src = ''; },
    },
    '#btn-watch': { classList: { toggle() {} } },
  };
  const sandbox = {
    state: { current: null, models: {} },
    WATCH_FRAME_MS: 1200,
    WATCH_URL_EVERY: 5,
    pendingFetches,
    objectUrls,
    revoked,
    Date,
    setInterval: () => ({ active: true }),
    clearInterval: () => {},
    fetch: () => new Promise((resolve) => pendingFetches.push(resolve)),
    api: async () => ({ tab: { url: 'https://example.test', title: 'Exemple' } }),
    URL: {
      createObjectURL(blob) {
        const value = `blob:${objectUrls.length + 1}`;
        objectUrls.push({ value, blob });
        return value;
      },
      revokeObjectURL(value) { revoked.push(value); },
    },
    $: (selector) => elements[selector],
  };

  vm.runInContext(
    `${watchSource}\ncontrols = { openWatch, closeWatch, watchTick };`,
    vm.createContext(sandbox),
    { filename: 'app.watch.vm.js' }
  );

  sandbox.controls.openWatch();
  assert.equal(pendingFetches.length, 1);

  // Le setInterval se déclenche avant que la première image soit arrivée : aucun second fetch.
  await sandbox.controls.watchTick();
  assert.equal(pendingFetches.length, 1);

  sandbox.controls.closeWatch();
  pendingFetches[0]({
    ok: true,
    blob: async () => ({ bytes: 'image-tardive' }),
    headers: { get: () => null },
  });
  await nextTurn();
  await nextTurn();

  assert.equal(objectUrls.length, 0);
  assert.equal(elements['#watch-img'].src, '');
});

test('notes : une pièce jointe tardive ne rejoint pas le formulaire qui a remplacé le sien', async () => {
  const noteSource = extract(
    "$('#note-file').addEventListener('change', async (e) => {",
    "\n$('#btn-note-save').addEventListener('click', async () => {"
  );
  const readers = [];
  const sandbox = { readers };

  vm.runInContext(
    `
      let noteFormGeneration = 4;
      let notePending = [];
      let changeHandler = null;
      let renderCount = 0;
      const noteFile = {
        addEventListener(type, handler) {
          if (type === 'change') changeHandler = handler;
        },
      };
      const notesForm = { classList: { contains: () => false } };
      const $ = (selector) => selector === '#note-file' ? noteFile : notesForm;
      const renderNoteAttachments = () => { renderCount += 1; };
      const notesError = (message) => { throw new Error(message); };
      class FileReader {
        constructor() {
          this.result = null;
          this.onload = null;
          this.onerror = null;
          readers.push(this);
        }
        readAsDataURL(file) { this.file = file; }
      }
      ${noteSource}
      runChange = (event) => changeHandler(event);
      replaceForm = () => {
        noteFormGeneration += 1;
        notePending = [{ name: 'nouveau.png', dataUrl: 'data:image/png;base64,Tk9VVkVBVQ==' }];
      };
      result = () => ({ pending: notePending, renderCount });
    `,
    vm.createContext(sandbox),
    { filename: 'app.notes-file-reader.vm.js' }
  );

  const input = { files: [{ name: 'ancien.png' }], value: 'ancien.png' };
  const pending = sandbox.runChange({ target: input });
  assert.equal(readers.length, 1);
  sandbox.replaceForm();
  readers[0].result = 'data:image/png;base64,QU5DSUVO';
  readers[0].onload();
  await pending;

  const result = JSON.parse(JSON.stringify(sandbox.result()));
  assert.deepEqual(result.pending, [
    { name: 'nouveau.png', dataUrl: 'data:image/png;base64,Tk9VVkVBVQ==' },
  ]);
  assert.equal(result.renderCount, 0);
});
