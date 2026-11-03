'use strict';

// Brouillons locaux par conversation. Le texte a un secours synchrone localStorage ; les
// pièces jointes vivent dans IndexedDB, sans promesse de synchronisation entre appareils.
(function draftsModule(global) {
  const DB_NAME = 'agenthub-ui';
  const STORE = 'drafts';
  const TEXT_PREFIX = 'ah.draft.text.';
  const queues = new Map();
  let dbPromise = null;
  let lastUpdatedAt = 0;

  function report(operation, error, extra = {}) {
    global.dispatchEvent(
      new CustomEvent('agenthub:draft-error', {
        detail: {
          operation,
          message: error && error.message ? error.message : String(error),
          textPreserved: true,
          ...extra,
        },
      })
    );
  }

  function openDb() {
    if (!('indexedDB' in global)) return Promise.reject(new Error('IndexedDB indisponible'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ouverture IndexedDB impossible'));
    });
    return dbPromise;
  }

  async function transact(mode, operation) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = () => reject(tx.error || (request && request.error) || new Error('IndexedDB a échoué'));
      tx.onabort = () => reject(tx.error || new Error('Transaction IndexedDB annulée'));
    });
  }

  function enqueue(id, operation) {
    const previous = queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(id, next);
    next.finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    });
    return next;
  }

  function textKey(id) {
    return `${TEXT_PREFIX}${id}`;
  }

  function nextUpdatedAt() {
    lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1);
    return lastUpdatedAt;
  }

  function saveText(id, text, updatedAt, imageManifest = []) {
    try {
      // Même vide, cette entrée est un tombstone : si une suppression IndexedDB échoue,
      // l'ancien brouillon ne doit pas ressusciter au prochain chargement.
      localStorage.setItem(textKey(id), JSON.stringify({ text, updatedAt, imageManifest }));
    } catch (error) {
      report('texte', error);
    }
  }

  function fallbackRecord(id) {
    try {
      const value = JSON.parse(localStorage.getItem(textKey(id)) || 'null');
      return value && typeof value.text === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  function imageSignature(image) {
    if (!image || !image.dataUrl) return null;
    if (image.draftSignature) return image.draftSignature;
    const data = String(image.dataUrl);
    // Le manifeste localStorage ne doit jamais contenir le data URL. Un échantillon aux deux
    // extrémités suffit à reconnaître notre propre enregistrement IndexedDB, et son hash est
    // calculé une seule fois par pièce jointe puis conservé sur l'objet.
    const sample = `${image.kind || ''}\0${image.name || ''}\0${data.length}\0${data.slice(0, 96)}\0${data.slice(-96)}`;
    let hash = 2166136261;
    for (let index = 0; index < sample.length; index += 1) {
      hash ^= sample.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    image.draftSignature = `v1-${data.length.toString(36)}-${(hash >>> 0).toString(36)}`;
    return image.draftSignature;
  }

  function imageManifest(images) {
    return (images || [])
      .filter(Boolean)
      .map((image) => ({
        id: image.id || null,
        kind: image.kind || null,
        name: image.name || null,
        signature: imageSignature(image),
      }));
  }

  function serializeImages(images) {
    return (images || [])
      .filter((image) => image && image.dataUrl)
      .map((image) => ({
        id: image.id,
        kind: image.kind,
        name: image.name,
        dataUrl: image.dataUrl,
        draftSignature: imageSignature(image),
      }));
  }

  function save(id, draft) {
    if (!id) return Promise.resolve(false);
    const text = String((draft && draft.text) || '');
    const draftImages = (draft && draft.images) || [];
    const images = serializeImages(draftImages);
    const manifest = imageManifest(draftImages);
    const updatedAt = nextUpdatedAt();
    saveText(id, text, updatedAt, manifest);
    return enqueue(id, async () => {
      try {
        if (!text.trim() && !images.length) await transact('readwrite', (store) => store.delete(id));
        else {
          await transact('readwrite', (store) =>
            store.put({ id, text, images, updatedAt })
          );
        }
        return true;
      } catch (error) {
        report('pièces jointes', error);
        return false;
      }
    });
  }

  function remove(id) {
    if (!id) return Promise.resolve(false);
    saveText(id, '', nextUpdatedAt(), []);
    return enqueue(id, async () => {
      try {
        await transact('readwrite', (store) => store.delete(id));
        return true;
      } catch (error) {
        report('suppression', error);
        return false;
      }
    });
  }

  async function dataUrlBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  async function materializeImages(images) {
    const out = [];
    for (const image of images || []) {
      try {
        const blob = await dataUrlBlob(image.dataUrl);
        out.push({ ...image, objectUrl: URL.createObjectURL(blob) });
      } catch (error) {
        report('restauration', error);
      }
    }
    return out;
  }

  function imagesFromNewerFallback(recordImages, manifest) {
    const pool = [...(recordImages || [])];
    const kept = [];
    let missing = 0;
    for (const expected of manifest || []) {
      if (!expected || !expected.signature) {
        missing += 1;
        continue;
      }
      const index = pool.findIndex(
        (image) =>
          imageSignature(image) === expected.signature &&
          (!expected.id || image.id === expected.id)
      );
      if (index === -1) missing += 1;
      else kept.push(pool.splice(index, 1)[0]);
    }
    return { images: kept, missing };
  }

  async function load(id) {
    if (!id) return null;
    const pending = queues.get(id);
    if (pending) await pending.catch(() => {});
    let record = null;
    try {
      record = await transact('readonly', (store) => store.get(id));
    } catch {
      // Le texte reste disponible même lorsque IndexedDB est bloqué ou privé.
    }
    const fallback = fallbackRecord(id);
    // localStorage est écrit avant la transaction : s'il est plus récent, celle-ci a échoué
    // ou n'a pas eu le temps de finir. Son manifeste léger permet de réutiliser uniquement
    // les blobs IndexedDB qui appartiennent encore au brouillon courant.
    if (fallback && (!record || Number(fallback.updatedAt) > Number(record.updatedAt || 0))) {
      const reconciled = imagesFromNewerFallback(
        (record && record.images) || [],
        Array.isArray(fallback.imageManifest) ? fallback.imageManifest : []
      );
      if (reconciled.missing) {
        report(
          'restauration-incomplete',
          new Error(`${reconciled.missing} pièce(s) jointe(s) absente(s) du stockage local`),
          { missing: reconciled.missing }
        );
      }
      record = {
        id,
        text: fallback.text,
        images: reconciled.images,
        updatedAt: fallback.updatedAt,
      };
    }
    const text = record && typeof record.text === 'string' ? record.text : '';
    const images = await materializeImages((record && record.images) || []);
    if (!text && !images.length) return null;
    return { text, images, updatedAt: (record && record.updatedAt) || null };
  }

  global.AgentHubDrafts = { save, load, remove };
})(window);
