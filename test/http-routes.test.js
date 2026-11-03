'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerConnectionsRoutes } = require('../lib/http/connections');
const { registerFolderRoutes } = require('../lib/http/folders');
const { resolveProject } = require('../lib/http/project-assets');
const { createSettingsChecks } = require('../lib/http/settings');

function fakeApp() {
  const routes = [];
  const app = { routes };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    app[method] = (path, handler) => routes.push({ method, path, handler });
  }
  app.route = (method, path) => routes.find((route) => route.method === method && route.path === path);
  return app;
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    type(type) { this.headers['content-type'] = type; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    end() { this.ended = true; return this; },
  };
}

test('le résolveur de projet accepte une clé directe et refuse une conversation inconnue', () => {
  const source = { key: (value) => String(value).trim() || null, projectOf: (conv) => conv.project };
  const store = { get: (id) => (id === 'known' ? { project: '/srv/project' } : null) };

  assert.deepEqual(resolveProject({ project: ' /srv/direct ' }, store, source), {
    project: '/srv/direct',
  });
  assert.deepEqual(resolveProject({ convId: 'known' }, store, source), { project: '/srv/project' });
  assert.deepEqual(resolveProject({ convId: 'missing' }, store, source), {
    error: 'Conversation inconnue',
  });
});

test('la route d ordre précède le paramètre de dossier et les secrets ne rendent pas leur valeur', () => {
  const app = fakeApp();
  const folders = [{ id: 'project', name: 'Projet' }];
  const broadcasts = [];
  const secretValue = 'sk-private-value';
  registerFolderRoutes({
    app,
    store: {
      folders: () => folders,
      reorderFolders: () => folders,
      createFolder: () => folders[0],
      renameFolder: () => true,
      removeFolder: () => {},
    },
    secrets: {
      MIN_LENGTH: 8,
      list: () => [{ name: 'TOKEN', length: secretValue.length }],
      set: () => ({ name: 'TOKEN' }),
      importEnv: () => ({ imported: ['TOKEN'], refused: [] }),
      remove: () => true,
      forget: () => {},
    },
    broadcast: (message) => broadcasts.push(message),
  });

  const order = app.routes.findIndex((route) => route.path === '/api/folders/order');
  const parameter = app.routes.findIndex((route) => route.path === '/api/folders/:id');
  assert.ok(order >= 0 && order < parameter);

  const res = response();
  app.route('get', '/api/folders/:id/secrets').handler({ params: { id: 'project' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.stringify(res.body).includes(secretValue), false);
  assert.deepEqual(res.body.secrets, [{ name: 'TOKEN', length: secretValue.length }]);
});

test('la connexion navigateur garde la demande active puis relance la conversation en file', async () => {
  const app = fakeApp();
  const broadcasts = [];
  const enqueued = [];
  const request = { id: 'request-1', convId: 'conv-1', service: 'GitHub', reason: 'authentifier le CLI' };
  const conv = { id: 'conv-1' };
  registerConnectionsRoutes({
    app,
    asyncRoute: (handler) => handler,
    providers: new Set(['claude']),
    accounts: { invalidate() {}, all: async () => [], get: async () => ({}) },
    login: { status: () => ({}), start: () => ({}), submitCode: () => ({}), clear() {}, logout: async () => {} },
    googleOauth: {
      publicConfiguration: () => ({}), accounts: () => [], configure() {}, begin: () => ({}),
      complete: async () => {}, apiRequest: async () => ({}), disconnect: () => true,
    },
    remoteBrowser: {
      state: async () => ({ state: 'open' }),
      start: async () => ({ state: 'open' }),
      close: async () => ({ state: 'closed' }),
      screenshot: async () => Buffer.alloc(0),
      navigate: async () => ({}), click: async () => ({}), type: async () => ({}),
      key: async () => ({}), scroll: async () => ({}),
    },
    authRequests: {
      list: () => [request],
      create: () => request,
      resolve: () => request,
    },
    watchBrowser: { where: async () => null, frame: async () => ({ mime: 'image/png', buffer: Buffer.alloc(0) }) },
    store: { get: (id) => (id === conv.id ? conv : null), addItem: () => null },
    running: new Map([[conv.id, {}]]),
    enqueue: (...args) => enqueued.push(args),
    dispatch: async () => {},
    broadcast: (message) => broadcasts.push(message),
  });

  const opened = response();
  await app.route('post', '/api/connections/browser').handler(
    { body: { url: 'https://github.com', requestId: request.id } },
    opened
  );
  assert.equal(opened.statusCode, 201);

  const state = response();
  await app.route('get', '/api/connections/browser').handler({ query: {} }, state);
  assert.equal(state.body.activeRequestId, request.id);

  const closed = response();
  await app.route('delete', '/api/connections/browser').handler({ query: {} }, closed);
  assert.equal(closed.body.request.id, request.id);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0][0], conv);
  assert.match(enqueued[0][1], /GitHub/);
  assert.ok(broadcasts.some((message) => message.type === 'auth-request-resolved'));
});

test('les contrôles de réglages utilisent les adaptateurs injectés', async () => {
  const requests = [];
  const checks = createSettingsChecks({
    notify: {
      loadConfig: () => ({ enabled: true, appUrl: 'https://agent.test' }),
      buildMessage: (value) => value,
      buildRequest: () => ({ url: 'https://notify.test', headers: {}, body: '{}' }),
    },
    mail: {
      config: () => ({ enabled: true, to: 'owner@example.test' }),
      send: async (message) => ({ sent: message.to === 'owner@example.test' }),
    },
    browserMcp: { config: () => ({ enabled: true, url: 'https://mcp.test' }) },
    host: '127.0.0.1',
    port: 3901,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{"name":"Playwright"}' };
    },
  });

  assert.equal((await checks.notify()).ok, true);
  assert.equal((await checks.mail()).ok, true);
  assert.deepEqual(await checks.browser(), { ok: true, detail: 'Répond : Playwright' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://mcp.test');
});
