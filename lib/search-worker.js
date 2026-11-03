'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { ConversationIndex } = require('./conversation-index');
const fs = require('node:fs');

function openIndex() {
  try { return new ConversationIndex({ databaseFile: workerData.databaseFile }); }
  catch (err) {
    // SQLite est un dérivé recréable. Une base corrompue ne doit pas rendre les JSONL
    // inaccessibles ; les erreurs de permission ou de code, elles, restent visibles.
    if (!/(malformed|not a database|corrupt)/i.test(String(err && err.message))) throw err;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${workerData.databaseFile}${suffix}`); }
      catch (unlinkError) { if (!unlinkError || unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
    return new ConversationIndex({ databaseFile: workerData.databaseFile });
  }
}

const index = openIndex();
let warmQueue = [];
let warmTimer = null;

function serializeError(err) {
  return { name: err && err.name, message: (err && err.message) || String(err), stack: err && err.stack };
}

function reply(requestId, work) {
  try { parentPort.postMessage({ type: 'result', requestId, result: work() }); }
  catch (err) { parentPort.postMessage({ type: 'error', requestId, error: serializeError(err) }); }
}

// Un journal par tick : l'indexation de fond laisse les pages et recherches se glisser entre
// deux conversations, et l'arrêt du worker annule le reste sans toucher aux JSONL.
function scheduleWarm() {
  if (warmTimer || !warmQueue.length) return;
  warmTimer = setTimeout(() => {
    warmTimer = null;
    const conv = warmQueue.shift();
    if (conv) {
      try { index.ensure(conv.id, conv.file); }
      catch (err) { parentPort.postMessage({ type: 'warmError', convId: conv.id, error: serializeError(err) }); }
    }
    scheduleWarm();
  }, 25);
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'warm') {
    const known = new Set(warmQueue.map((conv) => conv.id));
    for (const conv of message.conversations || []) if (!known.has(conv.id)) { known.add(conv.id); warmQueue.push(conv); }
    scheduleWarm();
    return;
  }
  if (message.type === 'forget') {
    warmQueue = warmQueue.filter((conv) => conv.id !== message.convId);
    try { index.forget(message.convId); }
    catch (err) { parentPort.postMessage({ type: 'warmError', convId: message.convId, error: serializeError(err) }); }
    return;
  }
  const { requestId } = message;
  if (!requestId) return;
  if (message.type === 'page') reply(requestId, () => index.page(message.convId, message.file, message.query));
  else if (message.type === 'resultItem') reply(requestId, () => index.result(message.convId, message.file, message.itemId));
  else if (message.type === 'landmarks') reply(requestId, () => index.landmarks(message.convId, message.file));
  else if (message.type === 'search') reply(requestId, () => index.search(message.term, message.conversations, message.filters));
});

process.on('exit', () => { try { index.close(); } catch { /* fermeture du process */ } });
