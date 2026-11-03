'use strict';

// Brouillons locaux des documents de conception. Rien n'est envoyé au projet avant un clic
// explicite sur Enregistrer. Le stockage est synchrone pour pouvoir être vidé à pagehide.
(function planDraftsModule(global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.AgentHubPlanDrafts = api;
})(typeof window !== 'undefined' ? window : null, function createPlanDraftsApi() {
  const PREFIX = 'ah.planDraft.v1.';
  const DEFAULT_MAX_CHARS = 1_000_000;

  function fingerprint(value) {
    const text = String(value == null ? '' : value);
    let forward = 2166136261;
    let backward = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      forward ^= text.charCodeAt(index);
      forward = Math.imul(forward, 16777619);
      backward ^= text.charCodeAt(text.length - index - 1);
      backward = Math.imul(backward, 16777619);
    }
    return `${text.length.toString(36)}-${(forward >>> 0).toString(36)}-${(backward >>> 0).toString(36)}`;
  }

  function keyOf(project, path) {
    const encodedProject = encodeURIComponent(String(project || ''));
    const encodedPath = encodeURIComponent(String(path || ''));
    // Préfixe de longueur : `/a.` + `b` et `/a` + `.b` ne doivent jamais partager une clé.
    return `${PREFIX}${encodedProject.length}:${encodedProject}${encodedPath}`;
  }

  function create(options = {}) {
    let storage = Object.prototype.hasOwnProperty.call(options, 'storage') ? options.storage : null;
    if (!Object.prototype.hasOwnProperty.call(options, 'storage')) {
      // Lire `localStorage` peut lui-même lever SecurityError (origine opaque, réglages de
      // confidentialité). Le panneau doit alors continuer avec son secours mémoire.
      try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch { storage = null; }
    }
    const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : DEFAULT_MAX_CHARS;
    const memory = new Map();
    const removed = new Set();

    function warn(reason, error) {
      if (typeof options.onWarning === 'function') options.onWarning(reason, error || null);
    }

    function save({ project, path, base, content }) {
      if (!project || !path) return { saved: false, persisted: false, reason: 'missing-key' };
      const key = keyOf(project, path);
      removed.delete(key);
      const record = {
        version: 1,
        project: String(project),
        path: String(path),
        baseFingerprint: fingerprint(base),
        content: String(content == null ? '' : content),
        updatedAt: Date.now(),
        persisted: false,
      };
      memory.set(key, record);
      if (record.content.length > maxChars) {
        try { if (storage) storage.removeItem(key); } catch { /* mémoire seulement */ }
        warn('too-large');
        return { saved: true, persisted: false, reason: 'too-large', record };
      }
      if (!storage) {
        warn('unavailable');
        return { saved: true, persisted: false, reason: 'unavailable', record };
      }
      try {
        record.persisted = true;
        storage.setItem(key, JSON.stringify(record));
        return { saved: true, persisted: true, reason: null, record };
      } catch (error) {
        // Une ancienne version persistée ne doit pas ressusciter après un échec de mise à
        // jour. Le brouillon courant reste disponible en mémoire pour cet onglet.
        try { storage.removeItem(key); } catch { /* rien de plus sûr à faire */ }
        record.persisted = false;
        warn('quota', error);
        return { saved: true, persisted: false, reason: 'quota', record };
      }
    }

    function load(project, path) {
      if (!project || !path) return null;
      const key = keyOf(project, path);
      if (removed.has(key)) return null;
      if (memory.has(key)) return memory.get(key);
      if (!storage) return null;
      try {
        const record = JSON.parse(storage.getItem(key) || 'null');
        if (
          !record ||
          record.version !== 1 ||
          record.project !== String(project) ||
          record.path !== String(path) ||
          typeof record.content !== 'string' ||
          typeof record.baseFingerprint !== 'string'
        ) return null;
        record.persisted = record.persisted !== false;
        memory.set(key, record);
        return record;
      } catch (error) {
        warn('unreadable', error);
        return null;
      }
    }

    function remove(project, path) {
      if (!project || !path) return true;
      const key = keyOf(project, path);
      memory.delete(key);
      if (!storage) return true;
      try {
        storage.removeItem(key);
        removed.delete(key);
        return true;
      } catch (error) {
        // Ce tombstone empêche une copie persistée impossible à supprimer de ressusciter dans
        // l'onglet courant. Un nouvel enregistrement de ce document le retire explicitement.
        removed.add(key);
        warn('remove', error);
        return false;
      }
    }

    function relation(record, serverContent) {
      if (!record) return 'none';
      return record.baseFingerprint === fingerprint(serverContent) ? 'same-base' : 'conflict';
    }

    return { save, load, remove, relation };
  }

  return { create, fingerprint, keyOf, DEFAULT_MAX_CHARS };
});
