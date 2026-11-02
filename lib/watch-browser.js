'use strict';

// Regarder la page que l'agent est en train de manipuler.
//
// Le service Playwright MCP tourne avec `--shared-browser-context` : **les onglets sont
// partagés entre ses sessions**. Un second client MCP voit donc la page ouverte par l'agent,
// et peut la photographier sans le déranger. Vérifié le 05/08/2026 — une session neuve a
// listé l'onglet ouvert par une autre, et sa capture montrait bien cette page-là.
//
// Il a fallu s'y reprendre à deux fois : le premier essai ne voyait qu'un `about:blank` et
// laissait croire que chaque session avait son onglet à elle. C'était un artefact — la
// session qui avait ouvert la page venait de se déconnecter, donc il n'y avait réellement
// plus rien à voir.
//
// agentHub est donc ici un **client** MCP, là où `lib/mcp-server.js` en est un serveur. Le
// protocole est écrit à la main pour les mêmes raisons : quatre appels, aucune dépendance.

const browser = require('./browser');

/** Une capture par intervalle de rafraîchissement ; au-delà on gênerait l'agent. */
const MIN_INTERVAL_MS = 1000;
const TIMEOUT_MS = 15_000;

/**
 * Au-delà, on cesse de resservir la dernière image.
 *
 * Le service refuse les appels concurrents : quand l'agent clique, notre capture échoue. Or
 * c'est exactement l'instant qu'on veut voir, et un trou dans la vue serait pire qu'une
 * image d'il y a une seconde. Passé ce délai en revanche, la page a probablement changé et
 * continuer à montrer l'ancienne serait mentir.
 */
const STALE_MS = 15_000;

let session = null;
let lastShotAt = 0;

/**
 * Le corps d'une réponse MCP en HTTP streamable, qui arrive tantôt en JSON, tantôt en
 * `text/event-stream`. Playwright répond en SSE même pour une requête unique.
 */
function parseSse(text) {
  const raw = String(text || '');
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  try {
    return JSON.parse(line ? line.slice(6) : raw);
  } catch {
    return null;
  }
}

/** L'image d'un résultat d'outil, s'il y en a une. */
function pickImage(content) {
  const part = (content || []).find((c) => c && c.type === 'image' && c.data);
  return part ? { mime: part.mimeType || 'image/jpeg', data: part.data } : null;
}

/**
 * L'onglet courant, tel que `browser_tabs` le décrit en markdown.
 *
 * Format observé : `- 0: (current) [Titre](https://…)`. On ne lit que la ligne marquée
 * courante — c'est celle que la capture montre.
 */
function pickTab(text) {
  for (const line of String(text || '').split('\n')) {
    const found = /^\s*-\s*\d+:\s*\(current\)\s*\[([^\]]*)\]\(([^)]*)\)/.exec(line);
    if (found) return { title: found[1] || '', url: found[2] || '' };
  }
  return null;
}

function endpoint() {
  const { url } = browser.config();
  return url;
}

async function rpc(body, expectBody = true) {
  const url = endpoint();
  if (!url) throw new Error('Aucun service de navigateur configuré');

  const headers = {
    'Content-Type': 'application/json',
    // Les deux : le serveur choisit, et Playwright choisit SSE.
    Accept: 'application/json, text/event-stream',
  };
  if (session) headers['Mcp-Session-Id'] = session;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Session expirée ou inconnue : on la jette pour que le prochain appel en ouvre une neuve.
  if (res.status === 404 || res.status === 400) {
    session = null;
    throw new Error(`Session de navigateur perdue (${res.status})`);
  }
  if (!res.ok) throw new Error(`Navigateur injoignable (${res.status})`);
  if (!session) session = res.headers.get('mcp-session-id');
  return expectBody ? parseSse(await res.text()) : null;
}

/** Ouvre une session MCP si nécessaire. Idempotent. */
async function connect() {
  if (session) return session;
  await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agenthub-watch', version: '1.0.0' },
    },
  });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  return session;
}

async function call(name, args) {
  await connect();
  const reply = await rpc({
    jsonrpc: '2.0',
    id: Date.now() % 100000,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  });
  if (!reply || reply.error) {
    throw new Error((reply && reply.error && reply.error.message) || 'Réponse illisible');
  }
  return (reply.result && reply.result.content) || [];
}

/**
 * Une image de la page courante.
 *
 * Rien d'autre : la capture ne dit pas sur quelle adresse elle a été prise, et l'apprendre
 * demanderait un second appel d'outil à chaque image. L'adresse se demande à part, par
 * `where()`, que la vue interroge bien moins souvent que les images.
 *
 * Cadencé, aussi : deux captures rapprochées n'apportent rien et chaque appel passe par le
 * service que l'agent utilise pour travailler. Une demande trop tôt rend la précédente.
 *
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
let lastFrame = null;

async function frame() {
  const now = Date.now();
  if (lastFrame && now - lastShotAt < MIN_INTERVAL_MS) return lastFrame;

  try {
    const content = await call('browser_take_screenshot', { type: 'jpeg' });
    const image = pickImage(content);
    if (!image) throw new Error("Le navigateur n'a pas rendu d'image");
    lastShotAt = now;
    lastFrame = { buffer: Buffer.from(image.data, 'base64'), mime: image.mime, stale: false };
    return lastFrame;
  } catch (err) {
    // Le service est occupé : l'agent est en train de s'en servir, et c'est précisément le
    // moment qu'on veut regarder. Rendre la dernière image vaut mieux qu'un trou — mais pas
    // indéfiniment, sinon la vue montrerait une page qui n'existe plus en prétendant vivre.
    if (lastFrame && now - lastShotAt < STALE_MS) return { ...lastFrame, stale: true };
    throw err;
  }
}

/** Adresse et titre de l'onglet courant, sans photographier. */
async function where() {
  const content = await call('browser_tabs', { action: 'list' });
  const text = content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return pickTab(text) || { url: '', title: '' };
}

/** Oublie la session : le prochain appel en rouvrira une. Sert aux tests et au ménage. */
function reset() {
  session = null;
  lastFrame = null;
  lastShotAt = 0;
}

module.exports = { MIN_INTERVAL_MS, STALE_MS, parseSse, pickImage, pickTab, frame, where, reset };
