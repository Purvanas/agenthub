'use strict';

/**
 * Encapsule la transition délicate « file -> préparation -> turn ».
 *
 * `dispatch` signale l'instant exact où le message rejoint le fil via `onAccepted`. Avant
 * cette frontière, toute annulation ou erreur doit remettre l'entrée à sa position initiale ;
 * après, la restaurer la dupliquerait entre la file et l'historique.
 */
function createQueuedDispatcher({ store, broadcastQueue, dequeue, dispatch }) {
  /** Remet à sa place un message retiré pour partir, si sa préparation n'a jamais abouti. */
  function restoreQueued(conv, entry, index) {
    const fresh = store.get(conv.id);
    if (!fresh || (fresh.queue || []).some((queued) => queued.id === entry.id)) return false;
    const queue = [...(fresh.queue || [])];
    queue.splice(Math.min(Math.max(index, 0), queue.length), 0, entry);
    store.update(fresh.id, { queue });
    fresh.queue = queue;
    broadcastQueue(fresh);
    return true;
  }

  async function dispatchQueued(conv, entry, extra) {
    const index = (conv.queue || []).findIndex((queued) => queued.id === entry.id);
    if (index === -1) return null;
    const removed = dequeue(conv, entry.id);
    if (!removed) return null;

    let accepted = false;
    try {
      const result = await dispatch(conv, removed.text, removed.images, extra, {
        onAccepted: () => { accepted = true; },
      });
      if (!accepted) restoreQueued(conv, removed, index);
      return result;
    } catch (err) {
      if (!accepted) restoreQueued(conv, removed, index);
      throw err;
    }
  }

  return { restoreQueued, dispatchQueued };
}

module.exports = { createQueuedDispatcher };
