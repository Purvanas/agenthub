'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function load(file, name) {
  const window = {};
  const context = vm.createContext({
    window,
    document: { querySelector: () => null, querySelectorAll: () => [], body: { classList: { add() {} } } },
    console,
  });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), context, { filename: file });
  return window[name];
}

function element(extra = {}) {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    ...extra,
  };
}

test('la galerie ignore une réponse devenue ancienne pour le même projet', async () => {
  const module = load('gallery-view.js', 'AgentHubGalleryView');
  const first = deferred();
  const second = deferred();
  const select = element({ value: 'p1' });
  const batches = element();
  const subtitle = element();
  const view = element();
  const nodes = {
    '#gal-project': select,
    '#gal-batches': batches,
    '#gallery-sub': subtitle,
    '#gallery-view': view,
  };
  let calls = 0;
  const controller = module.create({
    $: (selector) => nodes[selector],
    api: () => (++calls === 1 ? first.promise : second.promise),
    prefs: { read: () => null, write() {} },
    usableProviders: () => [],
    providerLabels: { codex: 'Codex' },
    providerIcon: () => '<i></i>',
    esc: (value) => String(value),
    escAttr: (value) => String(value).replaceAll('"', '&quot;'),
    money: (value) => `${value} $`,
    showView() {}, renderConversationList() {}, closeNav() {},
    askInput: async () => null, askChoice: async () => null, undoToast() {}, openLightbox() {},
  });

  const older = controller.loadImages();
  const newer = controller.loadImages();
  second.resolve({ images: [{ id: 'new', batchId: 'b', provider: 'codex', prompt: 'récent "cité"', state: 'done', file: true }] });
  assert.equal(await newer, true);
  first.resolve({ images: [{ id: 'old', batchId: 'b', provider: 'codex', prompt: 'ancien', state: 'done', file: true }] });
  assert.equal(await older, false);
  assert.match(batches.innerHTML, /récent/);
  assert.match(batches.innerHTML, /alt="récent &quot;cité&quot;"/);
  assert.doesNotMatch(batches.innerHTML, /ancien/);
});

test('les paramètres ignorent une réponse de chargement devenue ancienne', async () => {
  const module = load('settings-view.js', 'AgentHubSettingsView');
  const first = deferred();
  const second = deferred();
  const body = element();
  let calls = 0;
  const controller = module.create({
    $: (selector) => selector === '#settings-body' ? body : element(),
    api: () => (++calls === 1 ? first.promise : second.promise),
    esc: (value) => String(value),
    escAttr: (value) => String(value),
    cssEscape: (value) => String(value),
    showView() {}, renderConversationList() {}, closeNav() {},
    loadProjects: async () => {}, toast() {},
  });

  const older = controller.load();
  const newer = controller.load();
  second.resolve({ sections: { notify: { values: { enabled: true }, overridden: ['enabled'] } } });
  assert.equal(await newer, true);
  first.resolve({ sections: { notify: { values: { enabled: false }, overridden: [] } } });
  assert.equal(await older, false);
  assert.match(body.innerHTML, /set-badge/);
  assert.match(body.innerHTML, /checked/);
});

test('une sauvegarde de paramètres invalide le GET parti avant elle', async () => {
  const module = load('settings-view.js', 'AgentHubSettingsView');
  const oldRead = deferred();
  const body = element();
  const view = element();
  let handleClick;
  body.addEventListener = (type, handler) => { if (type === 'click') handleClick = handler; };
  const nodes = {
    '#settings-body': body,
    '#settings-view': view,
    '#btn-settings': element(),
    '#btn-settings-refresh': element(),
    '#btn-settings-back': element(),
  };
  let calls = 0;
  const controller = module.create({
    $: (selector) => nodes[selector] || element(),
    api: (method) => {
      calls += 1;
      if (method === 'GET') return oldRead.promise;
      return Promise.resolve({ sections: { notify: { values: { enabled: true }, overridden: ['enabled'] } } });
    },
    esc: (value) => String(value), escAttr: (value) => String(value), cssEscape: (value) => String(value),
    showView() {}, renderConversationList() {}, closeNav() {}, loadProjects: async () => {}, toast() {},
  });
  controller.mount();
  const stale = controller.load();
  const button = element({ isConnected: true, disabled: false });
  const enabled = element({ checked: true });
  const card = {
    dataset: { section: 'notify' },
    querySelector: (selector) => {
      if (selector === '[data-set="enabled"]') return enabled;
      if (selector === '[data-set-group="events"]') return { querySelectorAll: () => [] };
      return null;
    },
  };
  const target = {
    closest(selector) {
      if (selector === '.set-card') return card;
      if (selector === '.set-save') return button;
      return null;
    },
  };
  await handleClick({ target });
  oldRead.resolve({ sections: { notify: { values: { enabled: false }, overridden: [] } } });
  assert.equal(await stale, false);
  assert.equal(calls, 2);
  assert.match(body.innerHTML, /checked/);
  assert.match(body.innerHTML, /set-badge/);
});

test('une erreur de paramètres arrivée après navigation ne repeint pas la vue cachée', async () => {
  const module = load('settings-view.js', 'AgentHubSettingsView');
  const body = element({ innerHTML: 'contenu stable' });
  const hidden = element({ classList: { contains: (name) => name === 'hidden' } });
  const controller = module.create({
    $: (selector) => selector === '#settings-body' ? body : hidden,
    api: async () => { throw new Error('réponse tardive'); },
    esc: (value) => String(value), escAttr: (value) => String(value), cssEscape: (value) => String(value),
    showView() {}, renderConversationList() {}, closeNav() {}, loadProjects: async () => {}, toast() {},
  });
  assert.equal(await controller.load(), false);
  assert.equal(body.innerHTML, 'contenu stable');
});

test('les contrôleurs exposent uniquement leur factory publique', () => {
  const gallery = load('gallery-view.js', 'AgentHubGalleryView');
  const settings = load('settings-view.js', 'AgentHubSettingsView');
  const server = load('server-view.js', 'AgentHubServerView');
  assert.deepEqual(Object.keys(gallery).sort(), ['create']);
  assert.deepEqual(Object.keys(settings).sort(), ['create']);
  assert.deepEqual(Object.keys(server).sort(), ['create']);
  assert.deepEqual(Object.keys(gallery.create({})).sort(), ['loadImages', 'mount', 'show']);
  assert.deepEqual(Object.keys(settings.create({})).sort(), ['load', 'mount', 'show']);
  assert.deepEqual(Object.keys(server.create({})).sort(), ['mount', 'show']);
});

test('les contrôleurs sont chargés avant l’orchestrateur principal', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const app = html.indexOf('<script src="/app.js"></script>');
  assert.ok(app > 0);
  for (const file of ['gallery-view.js', 'settings-view.js', 'server-view.js']) {
    const position = html.indexOf(`<script src="/${file}"></script>`);
    assert.ok(position > 0, `${file} doit être chargé`);
    assert.ok(position < app, `${file} doit précéder app.js`);
  }
});

test('le panneau serveur ne laisse pas un relevé ancien écraser le nouveau', async () => {
  const module = load('server-view.js', 'AgentHubServerView');
  const first = deferred();
  const second = deferred();
  const view = element();
  const subtitle = element();
  const totals = element();
  const services = element();
  const nodes = {
    '#server-view': view, '#server-sub': subtitle, '#server-totals': totals,
    '#server-disk': element(), '#server-pm2': element(), '#server-services': services,
    '#server-sites': element(), '#server-open': element(),
  };
  let calls = 0;
  const controller = module.create({
    $: (selector) => nodes[selector],
    api: () => (++calls === 1 ? first.promise : second.promise),
    esc: (value) => String(value),
    escAttr: (value) => String(value).replaceAll('"', '&quot;'),
    showView() {}, renderConversationList() {}, closeNav() {},
  });
  const older = controller.show();
  const newer = controller.show();
  const payload = (hostname) => ({
    available: true,
    system: { hostname, platform: 'linux', nodeVersion: '24', loadAvg: [0, 0, 0], cpuCount: 1,
      memory: { used: 1, total: 2 }, disk: { used: 1, total: 2, free: 1 }, uptime: 1 },
    disk: [], pm2: [], services: [{ active: true, label: 'service', description: 'dit "bonjour"' }], sites: [],
  });
  second.resolve(payload('nouveau'));
  assert.equal(await newer, true);
  first.resolve(payload('ancien'));
  assert.equal(await older, false);
  assert.match(subtitle.textContent, /nouveau/);
  assert.doesNotMatch(subtitle.textContent, /ancien/);
  assert.match(services.innerHTML, /title="dit &quot;bonjour&quot;"/);
});
