'use strict';

// Le temps de prendre un instantané Git, aucun CLI n'existe encore. La réservation doit
// pourtant déjà compter comme un turn occupé : deux envois simultanés ne doivent pas
// ouvrir deux sessions qui écrivent dans le même flux fichier.
async function prepareTurn({ id, running, prepare, exists, start, onCancel, onError }) {
  if (running.has(id)) {
    const err = new Error('Un turn est déjà en cours de préparation ou d’exécution.');
    err.statusCode = 409;
    throw err;
  }
  const entry = { preparing: true, child: null, stopped: false };
  running.set(id, entry);
  try {
    const prepared = await prepare();
    if (running.get(id) !== entry || !exists()) return null;
    if (entry.stopped) {
      if (onCancel) onCancel();
      return null;
    }
    return start(prepared, entry);
  } catch (err) {
    if (running.get(id) === entry && exists() && onError) onError(err);
    throw err;
  } finally {
    // start() a remplacé la réservation par le vrai processus : ne jamais le retirer.
    if (running.get(id) === entry) running.delete(id);
  }
}

module.exports = { prepareTurn };
