'use strict';

// Les trois modules sont des IIFE de navigateur. On les charge dans une petite fenêtre VM :
// ce test vise leurs contrats d'état, pas un DOM artificiel ni app.js dans son ensemble.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function storage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function browser(start = '/') {
  const listeners = new Map();
  const localStorage = storage();
  const location = { pathname: '/', search: '', hash: '' };
  const setUrl = (value) => {
    const url = new URL(value, 'https://agenthub.test');
    location.pathname = url.pathname;
    location.search = url.search;
    location.hash = url.hash;
  };
  setUrl(start);

  const window = {
    location,
    localStorage,
    URLSearchParams,
    URL,
    AbortController,
    DOMException,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    history: {
      state: null,
      pushState(state, _title, url) {
        this.state = state;
        setUrl(url);
      },
      replaceState(state, _title, url) {
        this.state = state;
        setUrl(url);
      },
    },
  };
  window.window = window;
  return window;
}

function load(window, file) {
  const context = vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), context, {
    filename: file,
  });
  return window;
}

function exerciseComposerDraft({ visibleText = '', pendingImages = [], draft }) {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const start = app.indexOf('function applyComposerDraft(draft)');
  const end = app.indexOf('\nfunction parkComposerDraft', start);
  assert.ok(start >= 0 && end > start, 'applyComposerDraft doit rester extractible depuis app.js');
  const source = app.slice(start, end);
  const revoked = [];
  const sandbox = {
    initialText: visibleText,
    initialImages: JSON.parse(JSON.stringify(pendingImages)),
    initialDraft: JSON.parse(JSON.stringify(draft)),
    revoked,
    URL: { revokeObjectURL: (url) => revoked.push(url) },
  };
  vm.runInContext(
    `
      const MAX_IMAGES = 5;
      let attachSeq = 0;
      let pendingImages = initialImages;
      const prompt = { value: initialText };
      const $ = (selector) => {
        if (selector === '#prompt') return prompt;
        throw new Error('Sélecteur inattendu : ' + selector);
      };
      let persisted = 0;
      const autosizePrompt = () => {};
      const renderAttachments = () => {};
      const renderSkillMenu = () => {};
      const renderSkillBadge = () => {};
      const scheduleVisibleDraftPersistence = () => { persisted += 1; };
      const toastError = () => {};
      ${source}
      applyComposerDraft(initialDraft);
      result = { text: prompt.value, images: pendingImages, persisted, revoked };
    `,
    vm.createContext(sandbox),
    { filename: 'app.applyComposerDraft.vm.js' }
  );
  return JSON.parse(JSON.stringify(sandbox.result));
}

test('navigation : première visite, paramètres workspace et compatibilité du lien query', () => {
  const first = load(browser('/'), 'navigation.js');
  assert.equal(first.AgentHubNavigation.current().view, 'inbox');

  first.AgentHubNavigation.navigate({ view: 'project', project: '/var/www/app', q: 'bug mobile' });
  assert.equal(first.location.hash, '#view=project&project=%2Fvar%2Fwww%2Fapp&q=bug+mobile');
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.AgentHubNavigation.current())),
    { conv: null, focus: null, view: 'project', project: '/var/www/app', q: 'bug mobile' }
  );

  const legacy = load(browser('/?conv=abc&focus=item-7'), 'navigation.js');
  assert.equal(legacy.AgentHubNavigation.current().conv, 'abc');
  legacy.AgentHubNavigation.replace(legacy.AgentHubNavigation.current(), { silent: true });
  assert.equal(legacy.location.search, '');
  assert.equal(legacy.location.hash, '#conv=abc&focus=item-7');
});

test('navigation : popstate et hashchange identiques ne rouvrent pas deux fois le fil', () => {
  const page = load(browser('/#view=inbox'), 'navigation.js');
  const seen = [];
  page.addEventListener('agenthub:route', (event) => seen.push(event.detail));

  page.location.hash = '#conv=abc';
  page.dispatchEvent({ type: 'popstate' });
  page.dispatchEvent({ type: 'hashchange' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conv, 'abc');

  page.location.hash = '#view=archive';
  page.dispatchEvent({ type: 'popstate' });
  page.location.hash = '#conv=abc';
  page.dispatchEvent({ type: 'popstate' });
  assert.deepEqual(seen.map((route) => route.conv || route.view), ['abc', 'archive', 'abc']);
  assert.equal(JSON.parse(page.localStorage.getItem('ah.lastRoute')).conv, 'abc');
});

test('navigation : une navigation silencieuse ne bloque pas la prochaine route explicite', () => {
  const page = load(browser('/#view=inbox'), 'navigation.js');
  const seen = [];
  page.addEventListener('agenthub:route', (event) => seen.push(event.detail));

  page.AgentHubNavigation.navigate({ conv: 'a' }, { silent: true });
  page.AgentHubNavigation.navigate({ conv: 'b' }, { silent: true });
  page.AgentHubNavigation.navigate({ conv: 'a' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conv, 'a');
});

test('navigation : la position de lecture conserve ancre, offset et bas du fil', () => {
  const page = load(browser('/'), 'navigation.js');
  page.AgentHubNavigation.saveScroll('conv-a', { itemId: 'item-42', offset: -18.5, atBottom: false });
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.AgentHubNavigation.loadScroll('conv-a'))),
    { itemId: 'item-42', offset: -18.5, atBottom: false, savedAt: page.AgentHubNavigation.loadScroll('conv-a').savedAt }
  );
  page.AgentHubNavigation.saveScroll('conv-a', { atBottom: true });
  assert.equal(page.AgentHubNavigation.loadScroll('conv-a').atBottom, true);
  page.AgentHubNavigation.clearScroll('conv-a');
  assert.equal(page.AgentHubNavigation.loadScroll('conv-a'), null);
});

test('contexte async : navigation et changement de conversation rendent la réponse obsolète', () => {
  const page = browser('/');
  const state = { currentId: 'a' };
  page.agentHub = { getState: () => state };
  load(page, 'action-context.js');

  const first = page.AgentHubActionContext.capture({ conversationId: 'a', key: 'notes' });
  assert.equal(first.isCurrent(), true);
  page.dispatchEvent(new page.CustomEvent('agenthub:navigation'));
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason.name, 'AbortError');

  const second = page.AgentHubActionContext.capture({ conversationId: 'a' });
  state.currentId = 'b';
  assert.equal(second.isCurrent(), false);
  second.release();
});

test('composeur : la restauration Chrome du même texte reste idempotente', () => {
  const restored = exerciseComposerDraft({
    visibleText: 'Brouillon persistant — diagnostic\nDeuxième ligne',
    pendingImages: [],
    draft: {
      text: 'Brouillon persistant — diagnostic\r\nDeuxième ligne   ',
      images: [],
    },
  });
  assert.equal(restored.text, 'Brouillon persistant — diagnostic\nDeuxième ligne');
  assert.equal(restored.persisted, 1);
});

test('composeur : les PJ déjà matérialisées sont dédupliquées, les autres fusionnées', () => {
  const restored = exerciseComposerDraft({
    visibleText: 'saisie déjà visible',
    pendingImages: [
      {
        id: 'att1',
        kind: 'image',
        name: 'capture.png',
        dataUrl: 'data:image/png;base64,QQ==',
        objectUrl: 'blob:visible',
      },
    ],
    draft: {
      text: 'brouillon antérieur',
      images: [
        {
          id: 'att1',
          kind: 'image',
          name: 'capture.png',
          dataUrl: 'data:image/png;base64,QQ==',
          objectUrl: 'blob:duplicate',
        },
        {
          id: 'att2',
          kind: 'text',
          name: 'notes.md',
          dataUrl: 'data:text/markdown;base64,IyBOb3Rlcw==',
          objectUrl: 'blob:distinct',
        },
      ],
    },
  });

  assert.equal(restored.text, 'brouillon antérieur\n\nsaisie déjà visible');
  assert.equal(restored.images.length, 2);
  assert.deepEqual(
    restored.images.map((image) => image.dataUrl),
    ['data:text/markdown;base64,IyBOb3Rlcw==', 'data:image/png;base64,QQ==']
  );
  assert.deepEqual(restored.images.map((image) => image.id), ['att2', 'att1']);
  assert.deepEqual(restored.revoked, ['blob:duplicate']);
});

test('composeur : une collision de signature ne supprime pas deux contenus différents', () => {
  const prefix = `data:image/png;base64,${'A'.repeat(120)}`;
  const suffix = 'Z'.repeat(120);
  const firstData = `${prefix}1111${suffix}`;
  const secondData = `${prefix}2222${suffix}`;
  const restored = exerciseComposerDraft({
    pendingImages: [
      {
        id: 'att1',
        kind: 'image',
        name: 'meme.png',
        dataUrl: firstData,
        draftSignature: 'v1-collision-volontaire',
        objectUrl: 'blob:first',
      },
    ],
    draft: {
      text: '',
      images: [
        {
          id: 'att2',
          kind: 'image',
          name: 'meme.png',
          dataUrl: secondData,
          draftSignature: 'v1-collision-volontaire',
          objectUrl: 'blob:second',
        },
      ],
    },
  });

  assert.equal(restored.images.length, 2);
  assert.deepEqual(
    restored.images.map((image) => image.dataUrl),
    [secondData, firstData]
  );
  assert.deepEqual(restored.revoked, []);
});

function fakeIndexedDb() {
  const records = new Map();
  const control = { failWrites: false };
  const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx = {
        error: null,
        objectStore() {
          const finish = (request, operation, write = false) => {
            queueMicrotask(() => {
              if (write && control.failWrites) {
                tx.error = new DOMException('Quota dépassé', 'QuotaExceededError');
                if (tx.onerror) tx.onerror();
                return;
              }
              request.result = operation();
              if (tx.oncomplete) tx.oncomplete();
            });
            return request;
          };
          return {
            get(id) {
              return finish({}, () => clone(records.get(id)));
            },
            put(record) {
              return finish({}, () => records.set(record.id, clone(record)), true);
            },
            delete(id) {
              return finish({}, () => records.delete(id), true);
            },
          };
        },
      };
      return tx;
    },
  };

  return {
    records,
    control,
    open() {
      const request = { result: db };
      queueMicrotask(() => {
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

function draftsPage() {
  const page = browser('/');
  page.indexedDB = fakeIndexedDb();
  let blobSeq = 0;
  page.fetch = async (dataUrl) => ({ blob: async () => ({ dataUrl }) });
  page.URL = {
    createObjectURL: () => `blob:test-${++blobSeq}`,
  };
  return load(page, 'drafts.js');
}

test('brouillons : texte et pièce jointe sont rematérialisés après rechargement', async () => {
  const page = draftsPage();
  await page.AgentHubDrafts.save('a', {
    text: 'à reprendre',
    images: [{ id: 'att1', kind: 'image', name: 'capture.png', dataUrl: 'data:image/png;base64,AA==' }],
  });
  const restored = await page.AgentHubDrafts.load('a');
  assert.equal(restored.text, 'à reprendre');
  assert.equal(restored.images.length, 1);
  assert.equal(restored.images[0].objectUrl, 'blob:test-1');
});

test('brouillons : un quota IndexedDB dépassé garde le texte récent sans ressusciter les anciennes PJ', async () => {
  const page = draftsPage();
  const failures = [];
  page.addEventListener('agenthub:draft-error', (event) => failures.push(event.detail));
  await page.AgentHubDrafts.save('a', {
    text: 'ancien',
    images: [{ id: 'att1', dataUrl: 'data:image/png;base64,T0xE' }],
  });
  page.indexedDB.control.failWrites = true;
  assert.equal(
    await page.AgentHubDrafts.save('a', {
      text: 'texte récent',
      images: [{ id: 'att2', dataUrl: 'data:image/png;base64,TkVX' }],
    }),
    false
  );
  page.indexedDB.control.failWrites = false;

  const restored = await page.AgentHubDrafts.load('a');
  assert.equal(restored.text, 'texte récent');
  assert.equal(restored.images.length, 0);
  assert.deepEqual(
    failures.map((failure) => failure.operation),
    ['pièces jointes', 'restauration-incomplete']
  );
  assert.equal(failures.at(-1).missing, 1);
});

test('brouillons : un fallback texte plus récent conserve les PJ déjà présentes dans IndexedDB', async () => {
  const page = draftsPage();
  const image = {
    id: 'att1',
    kind: 'text',
    name: 'note.md',
    dataUrl: 'data:text/markdown;base64,IyBOb3Rl',
  };
  await page.AgentHubDrafts.save('a', { text: 'avant pagehide', images: [image] });

  // Simule la dernière écriture pagehide : localStorage est synchrone mais la transaction
  // IndexedDB n'a pas le temps d'aboutir avant la fermeture de l'onglet.
  page.indexedDB.control.failWrites = true;
  assert.equal(
    await page.AgentHubDrafts.save('a', { text: 'texte du pagehide', images: [{ ...image }] }),
    false
  );
  page.indexedDB.control.failWrites = false;

  const restored = await page.AgentHubDrafts.load('a');
  assert.equal(restored.text, 'texte du pagehide');
  assert.equal(restored.images.length, 1);
  assert.equal(restored.images[0].name, 'note.md');
});

test('brouillons : un manifeste plus récent sans PJ retire les anciens blobs', async () => {
  const page = draftsPage();
  await page.AgentHubDrafts.save('a', {
    text: 'avec PJ',
    images: [{ id: 'att1', kind: 'image', name: 'old.png', dataUrl: 'data:image/png;base64,T0xE' }],
  });
  page.indexedDB.control.failWrites = true;
  assert.equal(await page.AgentHubDrafts.save('a', { text: 'sans PJ', images: [] }), false);
  page.indexedDB.control.failWrites = false;

  const restored = await page.AgentHubDrafts.load('a');
  assert.equal(restored.text, 'sans PJ');
  assert.equal(restored.images.length, 0);
});

test('brouillons : signature identique mais id différent ne récupère pas le mauvais blob', async () => {
  const page = draftsPage();
  const failures = [];
  const prefix = `data:image/png;base64,${'A'.repeat(120)}`;
  const suffix = 'Z'.repeat(120);
  page.addEventListener('agenthub:draft-error', (event) => failures.push(event.detail));
  await page.AgentHubDrafts.save('a', {
    text: 'ancien',
    images: [
      {
        id: 'att1',
        kind: 'image',
        name: 'meme.png',
        dataUrl: `${prefix}1111${suffix}`,
      },
    ],
  });
  page.indexedDB.control.failWrites = true;
  await page.AgentHubDrafts.save('a', {
    text: 'récent',
    images: [
      {
        id: 'att2',
        kind: 'image',
        name: 'meme.png',
        dataUrl: `${prefix}2222${suffix}`,
      },
    ],
  });
  page.indexedDB.control.failWrites = false;

  const restored = await page.AgentHubDrafts.load('a');
  assert.equal(restored.text, 'récent');
  assert.equal(restored.images.length, 0);
  assert.equal(failures.at(-1).operation, 'restauration-incomplete');
});

test('brouillons : une suppression échouée laisse un tombstone et ne ressuscite rien', async () => {
  const page = draftsPage();
  await page.AgentHubDrafts.save('a', {
    text: 'à supprimer',
    images: [{ id: 'att1', dataUrl: 'data:image/png;base64,AA==' }],
  });
  page.indexedDB.control.failWrites = true;
  assert.equal(await page.AgentHubDrafts.remove('a'), false);
  page.indexedDB.control.failWrites = false;
  assert.equal(await page.AgentHubDrafts.load('a'), null);
});

test('brouillons : deux sauvegardes concurrentes restent ordonnées par conversation', async () => {
  const page = draftsPage();
  await Promise.all([
    page.AgentHubDrafts.save('a', { text: 'premier', images: [] }),
    page.AgentHubDrafts.save('a', { text: 'second', images: [] }),
  ]);
  assert.equal((await page.AgentHubDrafts.load('a')).text, 'second');
});
