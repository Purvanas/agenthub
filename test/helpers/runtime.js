'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const REPO = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO, 'server.js');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'cli-replay.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(work, { timeout = 10_000, interval = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await work();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(interval);
  }
  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`Délai dépassé en attendant ${label}${suffix}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function writeCliWrapper(root) {
  if (process.platform === 'win32') {
    const file = path.join(root, 'cli-replay.cmd');
    fs.writeFileSync(file, `@"${process.execPath}" "${FIXTURE}" %*\r\n`);
    return file;
  }
  const file = path.join(root, 'cli-replay');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FIXTURE)} "$@"\n`,
    { mode: 0o700 }
  );
  return file;
}

function appendLog(target, prefix, chunk) {
  target.value += `${prefix}${chunk}`;
  if (target.value.length > 200_000) target.value = target.value.slice(-200_000);
}

async function waitExit(child, timeout = 10_000) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error(`processus ${child.pid} toujours actif`));
    }, timeout);
    child.once('exit', onExit);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function ownedFixture(pid) {
  if (!Number.isInteger(pid) || pid < 2 || !isAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cli-replay.js');
  } catch {
    return false;
  }
}

async function terminateFixture(pid) {
  if (!ownedFixture(pid)) return;
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } }
  try {
    await waitFor(() => !isAlive(pid), { timeout: 2_000, label: `arrêt fixture ${pid}` });
  } catch {
    if (!ownedFixture(pid)) return;
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà terminé */ } }
    await waitFor(() => !isAlive(pid), {
      timeout: 2_000,
      label: `arrêt forcé fixture ${pid}`,
    }).catch(() => {});
  }
}

function safeRemove(root) {
  const target = path.resolve(root);
  const base = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!target.startsWith(base) || target === path.resolve(os.tmpdir())) {
    throw new Error(`refus de supprimer un dossier de test inattendu : ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

async function createRuntime(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agenthub-${label}-`));
  const data = path.join(root, 'data');
  const control = path.join(root, 'control');
  const project = path.join(root, 'project');
  for (const directory of [data, control, project, path.join(data, 'conv')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const settingsFile = path.join(data, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    notify: { enabled: false },
    mail: { enabled: false },
    browser: { enabled: false },
    memory: { enabled: false, writeFile: false },
  }));
  const panelToken = path.join(root, 'no-panel-token.json');
  const modelsCache = path.join(root, 'no-grok-models.json');
  const wrapper = writeCliWrapper(root);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = { value: '' };
  const children = [];
  let server = null;

  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    AGENTHUB_DATA: data,
    AGENTHUB_SETTINGS: settingsFile,
    AGENTHUB_CLAUDE_BIN: wrapper,
    AGENTHUB_CODEX_BIN: wrapper,
    AGENTHUB_GROK_BIN: wrapper,
    AGENTHUB_GROK_MODELS_CACHE: modelsCache,
    AGENTHUB_PANEL_TOKEN_FILE: panelToken,
    AGENTHUB_TEST_CONTROL_DIR: control,
    AGENTHUB_MCP_URL: `${baseUrl}/mcp`,
    AGENTHUB_AUTH_REQUEST_URL: `${baseUrl}/api/connections/requests`,
    AGENTHUB_ASK_URL: `${baseUrl}/api/asks`,
    AGENTHUB_NOTES_URL: `${baseUrl}/api/notes`,
    AGENTHUB_RULES_URL: `${baseUrl}/api/rules`,
    AGENTHUB_PLANS_URL: `${baseUrl}/api/plans`,
    AGENTHUB_GOOGLE_API_URL: `${baseUrl}/api/connections/google/api`,
    AGENTHUB_TICK_MS: '60000',
  };

  async function request(route, options = {}) {
    const { json, timeout = 10_000, ...init } = options;
    const headers = { ...(init.headers || {}) };
    let body = init.body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* réponse non JSON */ }
    return { status: response.status, headers: response.headers, buffer, text, json: parsed };
  }

  async function start() {
    if (server && server.exitCode === null && server.signalCode === null) {
      throw new Error('le serveur de test tourne déjà');
    }
    const child = spawn(process.execPath, [SERVER], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    children.push(child);
    child.stdout.on('data', (chunk) => appendLog(logs, `[serveur ${child.pid} stdout] `, chunk));
    child.stderr.on('data', (chunk) => appendLog(logs, `[serveur ${child.pid} stderr] `, chunk));
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`serveur arrêté (${child.exitCode || child.signalCode})\n${logs.value}`);
      }
      const health = await request('/api/health', { timeout: 1_000 });
      return health.status === 200 && health.json && health.json.ok;
    }, { timeout: 20_000, interval: 80, label: 'démarrage HTTP' });
    return child;
  }

  async function stop() {
    const child = server;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    try { await waitExit(child, 10_000); }
    catch (err) {
      child.kill('SIGKILL');
      await waitExit(child, 3_000).catch(() => {});
      throw err;
    }
  }

  function fixturePids() {
    const found = [];
    for (const file of fs.readdirSync(control)) {
      if (!/^pid-/.test(file)) continue;
      const pid = Number(fs.readFileSync(path.join(control, file), 'utf8'));
      if (Number.isInteger(pid)) found.push(pid);
    }
    return [...new Set(found)];
  }

  async function cleanup() {
    await stop().catch(() => {});
    for (const pid of fixturePids()) await terminateFixture(pid);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    safeRemove(root);
  }

  function diagnostics() {
    const sections = [logs.value || '(aucune sortie serveur)'];
    const turns = path.join(data, 'turns');
    try {
      for (const file of fs.readdirSync(turns)) {
        const target = path.join(turns, file);
        const stat = fs.statSync(target);
        if (!stat.isFile()) continue;
        const raw = fs.readFileSync(target);
        sections.push(`[turn ${file}, ${stat.size} octets]\n${raw.subarray(Math.max(0, raw.length - 8_000)).toString('utf8')}`);
      }
    } catch {
      // Le dossier n'existe pas avant le premier turn, et disparaît au nettoyage.
    }
    return sections.join('\n');
  }

  return {
    root, data, control, project, port, baseUrl, env, logs,
    request, start, stop, cleanup, fixturePids,
    diagnostics,
  };
}

function connectWebSocket(runtime, { timeout = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/ws`);
    const messages = [];
    const waiters = new Set();
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket non connecté\n${runtime.diagnostics()}`));
      ws.terminate();
    }, timeout);

    function publish(message) {
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message, messages)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }

    ws.on('message', (raw) => {
      try { publish(JSON.parse(raw.toString())); }
      catch { publish({ type: 'invalid-json', raw: raw.toString() }); }
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once('open', () => {
      clearTimeout(timer);
      resolve({
        ws,
        messages,
        waitFor(predicate, waitTimeout = timeout) {
          const existing = messages.find((message) => predicate(message, messages));
          if (existing) return Promise.resolve(existing);
          return new Promise((waitResolve, waitReject) => {
            const waiter = { predicate, resolve: waitResolve, timer: null };
            waiter.timer = setTimeout(() => {
              waiters.delete(waiter);
              waitReject(new Error(`Événement WebSocket absent\n${runtime.diagnostics()}`));
            }, waitTimeout);
            waiters.add(waiter);
          });
        },
        close() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        },
      });
    });
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = {
  createRuntime,
  connectWebSocket,
  delay,
  isAlive,
  sha256,
  waitFor,
};
