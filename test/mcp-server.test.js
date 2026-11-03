'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/asks')];
  delete require.cache[require.resolve('../lib/mcp-server')];
  return { mcp: require('../lib/mcp-server'), asks: require('../lib/asks') };
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize renvoie la version demandee par le client', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('initialize', { protocolVersion: '2025-03-26' }), null, {});
  // Négocier à la baisse ferait échouer des clients pour rien : on n'utilise que le socle
  // commun à toutes les révisions.
  assert.equal(res.result.protocolVersion, '2025-03-26');
  assert.deepEqual(res.result.capabilities.tools, { listChanged: false });
  assert.equal(res.result.serverInfo.name, 'agenthub');
});

test('initialize sans version annoncee retombe sur la notre', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('initialize', {}), null, {});
  assert.equal(res.result.protocolVersion, mcp.DEFAULT_PROTOCOL);
});

test('une notification ne recoit aucune reponse', async () => {
  const { mcp } = fresh();
  // Répondre à une notification est une faute de protocole, pas un détail cosmétique.
  assert.equal(await mcp.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, null, {}), null);
});

test('tools/list annonce ask_user et son schema', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('tools/list'), null, {});
  assert.equal(res.result.tools.length, 1);
  const tool = res.result.tools[0];
  assert.equal(tool.name, 'ask_user');
  assert.deepEqual(tool.inputSchema.required, ['question']);
  assert.ok(tool.inputSchema.properties.options);
  assert.equal(mcp.toolName(), 'mcp__agenthub__ask_user');
});

test('les listes vides sont declarees plutot que laissees inconnues', async () => {
  const { mcp } = fresh();
  // Certains clients les sondent au demarrage et journalisent une erreur par methode absente.
  assert.deepEqual((await mcp.dispatch(rpc('resources/list'), null, {})).result, { resources: [] });
  assert.deepEqual((await mcp.dispatch(rpc('prompts/list'), null, {})).result, { prompts: [] });
});

test('une methode inconnue rend une erreur JSON-RPC', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('completion/complete'), null, {});
  assert.equal(res.error.code, -32601);
});

test('un outil inconnu rend une erreur JSON-RPC', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('tools/call', { name: 'autre_chose' }), null, {});
  assert.equal(res.error.code, -32602);
});

test('ask_user attend, puis rend la reponse humaine', async () => {
  const { mcp, asks } = fresh();
  let created = null;
  const call = mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'On supprime ?' } }),
    'c1',
    { onCreate: (row) => (created = row), waitMs: 5000 }
  );

  // La demande existe et attend avant même que l'appel ne soit résolu : c'est ce qui permet
  // à l'interface de l'afficher pendant que l'agent patiente.
  await new Promise((r) => setImmediate(r));
  assert.ok(created);
  assert.equal(created.mode, 'live');
  assert.equal(asks.hasWaiter(created.id), true);

  asks.answer(created.id, 'Archive-la');
  const res = await call;
  assert.equal(res.result.content[0].text, 'Archive-la');
  assert.equal(res.result.isError, false);
});

test('sans reponse a temps, l outil rend la main au lieu de bloquer', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Alors ?' } }),
    'c1',
    { waitMs: 20 }
  );
  assert.equal(res.result.isError, true);
  // L'agent doit savoir quoi faire ensuite, sinon il s'arrête sur un échec opaque.
  assert.match(res.result.content[0].text, /termine le turn|poursuis/);
});

test('annuler la requete MCP ferme la question live sans attendre le plafond', async () => {
  const { mcp, asks } = fresh();
  let created;
  let settled;
  const call = mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Alors ?' } }),
    'c1',
    {
      onCreate: (row) => (created = row),
      onSettle: (row) => (settled = row),
      waitMs: 5000,
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asks.hasWaiter(created.id), true);
  const cancelled = await mcp.dispatch(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    'c1',
    {}
  );

  assert.equal(cancelled, null, 'une notification ne reçoit pas de réponse');
  const res = await call;
  assert.equal(res.result.isError, true);
  assert.equal(asks.get(created.id).status, 'expired');
  assert.equal(settled.status, 'expired');
});

test('une annulation tardive ne ferme pas la question qui a remplace la sienne', async () => {
  const { mcp, asks } = fresh();
  const created = [];
  const deps = { onCreate: (row) => created.push(row), waitMs: 5000 };
  const callA = mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Question A' } }, 101),
    'c1',
    deps
  );
  await new Promise((resolve) => setImmediate(resolve));

  const callB = mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Question B' } }, 102),
    'c1',
    deps
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
  assert.equal(asks.get(created[1].id).status, 'pending');

  await mcp.dispatch(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 101 } },
    'c1',
    {}
  );
  assert.equal(
    asks.get(created[1].id).status,
    'pending',
    "l'annulation de A ne doit jamais viser B"
  );

  await mcp.dispatch(
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 102 } },
    'c1',
    {}
  );
  assert.equal(asks.get(created[1].id).status, 'expired');
  assert.equal((await callA).result.isError, true);
  assert.equal((await callB).result.isError, true);
});

test('la conversation vient de l URL, ou de l argument en repli', async () => {
  const { mcp, asks } = fresh();
  const rows = [];
  const deps = { onCreate: (r) => rows.push(r), waitMs: 20 };

  await mcp.dispatch(rpc('tools/call', { name: 'ask_user', arguments: { question: 'Q' } }), 'depuis-url', deps);
  // Grok n'inscrit ses serveurs MCP que globalement : son URL ne peut pas porter la
  // conversation, il doit donner l'identifiant lui-même.
  await mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Q', convId: 'depuis-arg' } }),
    null,
    deps
  );
  assert.deepEqual(rows.map((r) => r.convId), ['depuis-url', 'depuis-arg']);
  assert.equal(asks.list().length, 2);
});

test('sans conversation du tout, l outil dit comment se rattraper', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(rpc('tools/call', { name: 'ask_user', arguments: { question: 'Q' } }), null, {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /AGENTHUB_CONV_ID/);
});

test('une conversation refusee par l hote ne cree pas de demande', async () => {
  const { mcp, asks } = fresh();
  const res = await mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: 'Q' } }),
    'fantome',
    { resolveConv: () => false }
  );
  assert.equal(res.result.isError, true);
  assert.equal(asks.list().length, 0);
});

test('une question vide est refusee sans bloquer l appel', async () => {
  const { mcp } = fresh();
  const res = await mcp.dispatch(
    rpc('tools/call', { name: 'ask_user', arguments: { question: '  ' } }),
    'c1',
    { waitMs: 20 }
  );
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /refusée/);
});
