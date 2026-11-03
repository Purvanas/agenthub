'use strict';

// Une configuration atomique et ordonnée par conversation. Le prochain message attend
// cette file : un réseau lent ne doit jamais envoyer la consigne avec l'ancien modèle.
(function modelSettingsModule(global) {
  function create({ save, onSaved = () => {}, onChange = () => {} }) {
    const entries = new Map();
    function state(id) {
      const entry = entries.get(id);
      return entry ? { pending: entry.pending > 0, desired: entry.desired, error: entry.error }
        : { pending: false, desired: null, error: null };
    }
    function update(id, pair) {
      let entry = entries.get(id);
      if (!entry) {
        entry = { pending: 0, revision: 0, promise: Promise.resolve(), desired: null, error: null };
        entries.set(id, entry);
      }
      const revision = ++entry.revision;
      const desired = { model: pair.model || '', effort: pair.effort || '' };
      entry.desired = desired;
      entry.error = null;
      entry.pending += 1;
      const previous = entry.promise;
      const operation = previous.catch(() => {}).then(() => save(id, desired)).then((result) => {
        onSaved(id, result);
        if (entry.revision === revision) { entry.desired = null; entry.error = null; }
        return result;
      }).catch((error) => {
        if (entry.revision === revision) entry.error = error;
        throw error;
      }).finally(() => {
        entry.pending -= 1;
        onChange(id, state(id));
      });
      entry.promise = operation;
      // Le client peut seulement observer state()/wait() : ne jamais créer de rejection
      // globale si l'utilisateur quitte le fil avant la réponse.
      operation.catch(() => {});
      onChange(id, state(id));
      return operation;
    }
    async function wait(id) {
      const entry = entries.get(id);
      if (!entry) return;
      let observed;
      do {
        observed = entry.promise;
        try { await observed; } catch { /* l'erreur canonique est celle du dernier choix */ }
      } while (observed !== entry.promise);
      if (entry.error) throw entry.error;
    }
    function cancelFailed(id) {
      const entry = entries.get(id);
      if (!entry || entry.pending) return;
      entry.error = null; entry.desired = null;
      onChange(id, state(id));
    }
    return { state, update, wait, cancelFailed };
  }
  global.AgentHubModelSettings = { create };
})(window);
