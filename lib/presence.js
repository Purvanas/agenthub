'use strict';

// Qui regarde quoi, en ce moment.
//
// Sert à une seule décision, mais elle compte : faut-il sonner le téléphone quand un agent
// pose une question ? Si quelqu'un a la conversation sous les yeux, non — il va répondre, et
// une notification serait du bruit. Si personne ne regarde, oui, et tout de suite.
//
// L'état vit en mémoire et n'a pas à survivre : une présence est vraie tant que le websocket
// l'est. Un redémarrage coupe les sockets, les clients se reconnectent et se réannoncent.

/**
 * Au-delà de ce silence, un client n'est plus considéré comme présent.
 *
 * Le `close` du websocket suffit dans le cas normal, mais pas toujours : un téléphone qu'on
 * met en veille, un Wi-Fi qui tombe, et la socket reste ouverte côté serveur un long moment.
 * Le battement du navigateur est deux fois plus rapide que ce seuil, pour qu'un client vivant
 * ne soit jamais compté absent.
 */
const STALE_MS = 90_000;

/** Délai laissé à qui regarde avant de sonner ailleurs. */
const GRACE_MS = Number(process.env.AGENTHUB_ASK_GRACE_MS) || 60_000;

const clients = new Map();

function join(id) {
  clients.set(id, { convId: null, visible: false, at: Date.now() });
}

/**
 * Met à jour ce qu'un client regarde. Ignoré si le client n'est pas connu : une annonce qui
 * arrive après le `close` ne doit pas ressusciter une présence.
 */
function update(id, spec) {
  const client = clients.get(id);
  if (!client) return null;
  if (spec && spec.convId !== undefined) client.convId = spec.convId ? String(spec.convId) : null;
  if (spec && spec.visible !== undefined) client.visible = Boolean(spec.visible);
  client.at = Date.now();
  return client;
}

function leave(id) {
  return clients.delete(id);
}

function fresh(client, now) {
  return now - client.at < STALE_MS;
}

/**
 * Y a-t-il un client **visible** sur cette conversation ?
 *
 * Le critère se réduit à ça, et non à un type d'appareil. « Je suis sur mon PC » et « je suis
 * sur mon téléphone mais dans un autre fil » se répondent tous les deux par cette question :
 * ce qui compte n'est pas l'écran, c'est si la question va être vue.
 */
function watching(convId, now = Date.now()) {
  if (!convId) return false;
  const target = String(convId);
  for (const client of clients.values()) {
    if (client.visible && client.convId === target && fresh(client, now)) return true;
  }
  return false;
}

/** Vue d'ensemble, pour le journal et les tests. */
function snapshot(now = Date.now()) {
  const rows = [];
  for (const [id, client] of clients) {
    if (fresh(client, now)) rows.push({ id, convId: client.convId, visible: client.visible });
  }
  return rows;
}

function clear() {
  clients.clear();
}

module.exports = { STALE_MS, GRACE_MS, join, update, leave, watching, snapshot, clear };
