'use strict';

function orderQueue(current, ids) {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  if (!Array.isArray(ids) || ids.length !== current.length ||
      new Set(ids).size !== current.length || ids.some((id) => !byId.has(id))) {
    const err = new Error('Liste d’identifiants incomplète, inconnue ou dupliquée');
    err.statusCode = 400;
    throw err;
  }
  return ids.map((id) => byId.get(id));
}

module.exports = { orderQueue };
