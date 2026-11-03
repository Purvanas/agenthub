'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class SearchService {
  constructor({ fileOf, indexDir, workerFile } = {}) {
    if (typeof fileOf !== 'function') throw new TypeError('fileOf doit être une fonction');
    this.fileOf = fileOf;
    const sample = fileOf('__index_probe__');
    this.indexDir = indexDir || path.join(path.dirname(path.dirname(sample)), 'indexes');
    this.databaseFile = path.join(this.indexDir, 'conversations.sqlite');
    this.workerFile = workerFile || path.join(__dirname, 'search-worker.js');
    this.worker = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.closed = false;
  }

  ensureWorker() {
    if (this.closed) throw new Error('service d’index fermé');
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerFile, { workerData: { databaseFile: this.databaseFile } });
    this.worker = worker;
    worker.on('message', (message) => this.onMessage(message));
    worker.on('error', (err) => this.onWorkerFailure(worker, err));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      if (this.closed) { this.worker = null; return; }
      this.onWorkerFailure(worker, new Error(`worker d’index arrêté (code ${code})`));
    });
    return worker;
  }

  onMessage(message) {
    if (message && message.type === 'warmError') {
      console.error(`indexation de ${message.convId} impossible : ${message.error.message}`);
      return;
    }
    if (!message || !message.requestId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'result') { pending.resolve(message.result); return; }
    const details = message.error || {};
    const err = new Error(details.message || 'indexation impossible');
    err.name = details.name || 'Error';
    if (details.stack) err.stack = details.stack;
    pending.reject(err);
  }

  onWorkerFailure(worker, err) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  request(type, payload) {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = this.ensureWorker(); }
      catch (err) { reject(err); return; }
      this.pending.set(requestId, { resolve, reject });
      try { worker.postMessage({ type, requestId, ...payload }); }
      catch (err) { this.onWorkerFailure(worker, err); }
    });
  }

  page(convId, query = {}) {
    return this.request('page', { convId, file: this.fileOf(convId), query });
  }

  result(convId, itemId) {
    return this.request('resultItem', { convId, itemId, file: this.fileOf(convId) });
  }

  landmarks(convId) {
    return this.request('landmarks', { convId, file: this.fileOf(convId) });
  }

  search(term, conversations, filters = {}) {
    const needle = String(term || '').trim().toLowerCase();
    if (needle.length < 2) return Promise.resolve({ term: needle, results: [], truncated: false });
    const payload = conversations.map((conv) => ({ id: conv.id, title: conv.title, file: this.fileOf(conv.id) }));
    return this.request('search', { term, conversations: payload, filters });
  }

  warm(conversations) {
    if (this.closed) return;
    const payload = conversations.map((conv) => ({ id: conv.id, file: this.fileOf(conv.id) }));
    try { this.ensureWorker().postMessage({ type: 'warm', conversations: payload }); }
    catch (err) { if (this.worker) this.onWorkerFailure(this.worker, err); }
  }

  forget(convId) {
    if (this.closed) return;
    let worker;
    try { worker = this.ensureWorker(); worker.postMessage({ type: 'forget', convId }); }
    catch (err) { if (worker) this.onWorkerFailure(worker, err); }
  }

  async close() {
    this.closed = true;
    const err = new Error('service d’index fermé');
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    // terminate() annule aussi une reconstruction ou un warm en cours. SQLite rejoue/annule
    // sa transaction ; le JSONL source n'est jamais modifié.
    if (worker) await worker.terminate();
  }
}

module.exports = { SearchService };
