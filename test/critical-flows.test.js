'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createRuntime,
  connectWebSocket,
  isAlive,
  sha256,
  waitFor,
} = require('./helpers/runtime');

function withServerLogs(runtime, err) {
  err.message += `\n\nSortie des serveurs :\n${runtime.diagnostics()}`;
  return err;
}

function conversationMeta(id, cwd) {
  const now = '2026-11-03T12:00:00.000Z';
  return {
    id,
    provider: 'claude',
    cwd,
    model: 'fixture-v1',
    effort: null,
    browser: false,
    title: 'Historique synthétique',
    titleAuto: false,
    status: 'idle',
    contextTokens: 0,
    contextWindow: 0,
    lastModels: [],
    queue: [],
    goal: null,
    worktree: null,
    pinned: false,
    archived: false,
    folder: null,
    triggerId: null,
    parentId: null,
    providerSessionId: id,
    sessionStarted: false,
    forkFrom: null,
    createdAt: now,
    updatedAt: now,
    totalCostUsd: 0,
    lastCostUsd: null,
  };
}

function seedLargeHistory(runtime) {
  const id = 'history_fixture';
  const meta = conversationMeta(id, runtime.project);
  fs.writeFileSync(path.join(runtime.data, 'index.json'), JSON.stringify({
    conversations: [{ ...meta, project: runtime.project }],
    folders: [],
    triggers: [],
  }));
  fs.writeFileSync(path.join(runtime.data, 'conv', `${id}.json`), JSON.stringify(meta));
  const journal = path.join(runtime.data, 'conv', `${id}.jsonl`);
  const fd = fs.openSync(journal, 'w');
  try {
    const padding = 'x'.repeat(10_800);
    for (let index = 0; index < 1_900; index += 1) {
      fs.writeSync(fd, `${JSON.stringify({
        id: `archive-${String(index).padStart(4, '0')}`,
        ts: `2026-10-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        kind: 'text',
        text: `archive ${index} ${padding}`,
      })}\n`);
    }
    for (let index = 0; index < 120; index += 1) {
      const item = index === 100
        ? {
            id: 'tool-large',
            ts: '2026-11-03T12:00:00.000Z',
            kind: 'tool',
            tool: 'fixture',
            input: { path: '/tmp/fixture' },
            result: `BEGIN-${'R'.repeat(20_000)}-END`,
          }
        : {
            id: `tail-${String(index).padStart(3, '0')}`,
            ts: '2026-11-03T12:00:00.000Z',
            kind: index % 2 ? 'text' : 'user',
            text: `message récent ${index}`,
          };
      fs.writeSync(fd, `${JSON.stringify(item)}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(fs.statSync(journal).size >= 19 * 1024 * 1024, 'le journal doit exercer un historique d’environ 20 Mo');
  return { id, journal, hash: sha256(journal) };
}

test('HTTP réel : erreurs, scripts et pagination bornée d’un historique de 20 Mo', { timeout: 90_000 }, async (t) => {
  const runtime = await createRuntime('http');
  t.after(() => runtime.cleanup());
  const history = seedLargeHistory(runtime);

  try {
    await runtime.start();

    const invalid = await runtime.request('/api/conversations/bad%24id?limit=50');
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.json, { error: 'Identifiant invalide' });

    const missing = await runtime.request('/api/conversations/missing-id?limit=50');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'Conversation introuvable' });

    const middlewareError = await runtime.request(`/api/conversations/${history.id}/queue/order`, {
      method: 'POST',
      json: { ids: ['inconnu'] },
    });
    assert.equal(middlewareError.status, 400);
    assert.match(middlewareError.json.error, /incomplète|inconnue|dupliquée/);

    const absent = await runtime.request('/api/route-absente');
    assert.equal(absent.status, 404);

    const html = await runtime.request('/');
    assert.equal(html.status, 200);
    const scripts = [...html.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) => match[1]);
    assert.ok(scripts.length > 10, 'la page doit déclarer ses contrôleurs');
    assert.equal(scripts.at(-1), '/app.js', 'app.js compose les contrôleurs déjà chargés');
    for (const view of ['/gallery-view.js', '/settings-view.js', '/server-view.js']) {
      assert.ok(scripts.indexOf(view) >= 0 && scripts.indexOf(view) < scripts.indexOf('/app.js'));
    }
    for (const script of scripts) {
      const resource = await runtime.request(script);
      assert.equal(resource.status, 200, `${script} doit être servi`);
      assert.ok(resource.buffer.length > 0, `${script} ne doit pas être vide`);
    }

    const latest = await runtime.request(`/api/conversations/${history.id}?limit=50`, { timeout: 30_000 });
    assert.equal(latest.status, 200);
    assert.equal(latest.json.conversation.items.length, 50);
    assert.ok(latest.buffer.length < 250_000, `réponse mobile trop lourde : ${latest.buffer.length} octets`);
    assert.equal(latest.json.page.total, 2_020);
    assert.equal(latest.json.page.hasMore, true);

    const tool = latest.json.conversation.items.find((item) => item.id === 'tool-large');
    assert.ok(tool);
    assert.equal(tool.result.length, 6_000);
    assert.equal(tool.resultTruncated, true);
    assert.equal(tool.resultLength, 20_010);

    const before = latest.json.page.before;
    const previous = await runtime.request(
      `/api/conversations/${history.id}?limit=50&before=${encodeURIComponent(before)}`,
      { timeout: 30_000 }
    );
    assert.equal(previous.status, 200);
    assert.equal(previous.json.conversation.items.length, 50);
    assert.equal(previous.json.page.hasNewer, true);
    assert.ok(previous.buffer.length < 250_000);

    const resync = await runtime.request(`/api/conversations/${history.id}?limit=100`, { timeout: 30_000 });
    const pagedIds = [...previous.json.conversation.items, ...latest.json.conversation.items].map((item) => item.id);
    assert.deepEqual(resync.json.conversation.items.map((item) => item.id), pagedIds);
    assert.equal(new Set(pagedIds).size, 100, 'les fenêtres ne doivent ni se chevaucher ni perdre un item');
    assert.ok(resync.buffer.length < 350_000);

    const full = await runtime.request(`/api/conversations/${history.id}/items/tool-large/result`, { timeout: 30_000 });
    assert.equal(full.status, 200);
    assert.equal(full.json.result.length, 20_010);
    assert.match(full.json.result, /^BEGIN-R+\-END$/);
    assert.equal(sha256(history.journal), history.hash, 'l’index dérivé ne doit jamais réécrire le JSONL source');
  } catch (err) {
    throw withServerLogs(runtime, err);
  }
});

test('reprise Linux : le CLI détaché survit, le flux partiel reprend une seule fois et le modèle actif reste figé', { timeout: 90_000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('la survie du groupe détaché est validée sur Linux, comme la production');
  const runtime = await createRuntime('restart');
  t.after(() => runtime.cleanup());
  let firstSocket = null;
  let secondSocket = null;

  try {
    await runtime.start();
    firstSocket = await connectWebSocket(runtime);
    const hello = await firstSocket.waitFor((message) => message.type === 'hello');
    assert.deepEqual(hello.running, []);

    const created = await runtime.request('/api/conversations', {
      method: 'POST',
      json: { provider: 'claude', cwd: runtime.project, model: 'fixture-v1' },
    });
    assert.equal(created.status, 201);
    const convId = created.json.conversation.id;
    await runtime.request(`/api/conversations/${convId}`, {
      method: 'PATCH',
      json: { title: 'Fixture sans titrage automatique' },
    });
    firstSocket.ws.send(JSON.stringify({ type: 'presence', convId, visible: true }));
    await waitFor(async () => {
      const state = await runtime.request('/api/presence');
      return state.json.clients.some((client) => client.convId === convId && client.visible);
    }, { label: 'présence WebSocket' });

    const sent = await runtime.request(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      json: { prompt: 'Exécute la fixture sans appel externe.' },
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.json, { queued: false });
    await firstSocket.waitFor(
      (message) => message.type === 'delta' && message.convId === convId && message.text.includes('flux fixture')
    );

    const ready = path.join(runtime.control, `ready-${convId}`);
    await waitFor(() => fs.existsSync(ready), { label: 'ligne JSONL partielle du faux CLI' });
    const [fixturePid] = runtime.fixturePids();
    assert.ok(fixturePid && isAlive(fixturePid), 'le faux CLI doit être actif avant le redémarrage');

    const changed = await runtime.request(`/api/conversations/${convId}`, {
      method: 'PATCH',
      json: { model: 'fixture-v2', effort: '' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.conversation.applies, 'next-turn');
    assert.equal(changed.json.conversation.modelSelection.next.model, 'fixture-v2');
    assert.equal(changed.json.conversation.modelSelection.active.launchedModel, 'fixture-v1');

    await runtime.stop();
    assert.equal(isAlive(fixturePid), true, 'SIGTERM du serveur ne doit pas tuer le CLI détaché');
    firstSocket.close();
    await runtime.start();

    secondSocket = await connectWebSocket(runtime);
    const resumedHello = await secondSocket.waitFor((message) => message.type === 'hello');
    assert.ok(resumedHello.running.includes(convId));
    secondSocket.ws.send(JSON.stringify({ type: 'presence', convId, visible: true }));
    await waitFor(async () => {
      const state = await runtime.request('/api/presence');
      return state.json.clients.some((client) => client.convId === convId && client.visible);
    }, { label: 'présence WebSocket après reconnexion' });

    const resumed = await runtime.request(`/api/conversations/${convId}?limit=50`, { timeout: 20_000 });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.json.running, true);
    assert.equal(resumed.json.conversation.modelSelection.next.model, 'fixture-v2');
    assert.equal(resumed.json.conversation.modelSelection.active.launchedModel, 'fixture-v1');
    assert.equal(
      resumed.json.conversation.items.filter((item) => item.kind === 'user').length,
      1,
      'le message accepté avant le redémarrage ne doit pas être rejoué'
    );

    fs.writeFileSync(path.join(runtime.control, `release-${convId}`), 'ok');
    await secondSocket.waitFor(
      (message) => message.type === 'item' && message.convId === convId &&
        message.item.kind === 'text' && message.item.text === 'Réponse finale fixture',
      15_000
    );
    const metrics = await secondSocket.waitFor(
      (message) => message.type === 'metrics' && message.convId === convId,
      15_000
    );
    assert.deepEqual(metrics.lastModelSelection.models, ['fixture-v1']);
    await waitFor(async () => {
      const health = await runtime.request('/api/health');
      return !health.json.running.includes(convId);
    }, { timeout: 20_000, label: 'clôture du turn repris' });

    const finished = await runtime.request(`/api/conversations/${convId}?limit=100`, { timeout: 20_000 });
    const items = finished.json.conversation.items;
    assert.equal(items.filter((item) => item.kind === 'user').length, 1);
    assert.equal(items.filter((item) => item.kind === 'text' && item.text === 'Réponse finale fixture').length, 1);
    assert.equal(items.some((item) => JSON.stringify(item).includes('�')), false, 'aucun octet UTF-8 partiel ne doit être persisté');
    assert.equal(finished.json.conversation.modelSelection.next.model, 'fixture-v2');
    assert.equal(finished.json.conversation.modelSelection.active, null);
    assert.deepEqual(finished.json.conversation.modelSelection.last.models, ['fixture-v1']);

    const journal = path.join(runtime.data, 'conv', `${convId}.jsonl`);
    const journalItems = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(journalItems.filter((item) => item.kind === 'user').length, 1);
    assert.equal(journalItems.filter((item) => item.kind === 'text' && item.text === 'Réponse finale fixture').length, 1);
    const inflight = JSON.parse(fs.readFileSync(path.join(runtime.data, 'inflight.json'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(inflight, convId), false);
    assert.equal(fs.existsSync(path.join(runtime.data, 'turns', `${convId}.jsonl`)), false);
  } catch (err) {
    throw withServerLogs(runtime, err);
  } finally {
    if (firstSocket) firstSocket.close();
    if (secondSocket) secondSocket.close();
  }
});
