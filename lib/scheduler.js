'use strict';

// Planificateur des déclencheurs.
//
// Une ligne de crontab appelant un endpoint n'apporterait aucune robustesse : si le
// processus est arrêté, l'endpoint l'est aussi. Elle ajouterait en revanche une pièce à
// maintenir hors de l'application. La boucle vit donc dans le processus, et les échéances
// sont persistées pour survivre à un redémarrage — donc à chaque déploiement.
//
// Ce module décide *quand*. Il ne sait ni créer une conversation ni lancer un agent :
// ces actions lui sont fournies par `server.js`, qui seul détient le chemin d'envoi, les
// process en cours et les websockets.

const triggers = require('./triggers');
const planned = require('./planned');

// Cadence de vérification. Plus elle est fine, plus l'échéance est précise ; plus elle
// est grossière, moins le processus travaille pour rien. Trente secondes donnent une
// précision suffisante pour des fréquences qui commencent à l'heure.
const TICK_MS = Number(process.env.AGENTHUB_TICK_MS || 30_000);

const DAY_MS = 86_400_000;

/** Déclencheurs dont l'échéance est atteinte, actifs ou non. */
function due(list, now) {
  return list.filter((t) => t.nextRunAt && new Date(t.nextRunAt).getTime() <= now.getTime());
}

/**
 * Échéance suivante après une échéance atteinte.
 *
 * Le rattrapage est borné à une exécution. Un processus arrêté trois jours a manqué
 * soixante-douze échéances horaires ; les rejouer toutes serait absurde et coûteux. On
 * en joue une — celle qui vient d'être constatée — et on repart de la prochaine échéance
 * réellement à venir.
 */
function reschedule(trigger, now) {
  let next = triggers.nextRun(trigger, new Date(trigger.nextRunAt));
  // `null` n'est pas une erreur : c'est ce que répond une fréquence « une seule fois »,
  // qui n'a pas d'après. Le déclencheur est alors désarmé pour de bon.
  if (!next) return null;
  let guard = 0;
  while (next.getTime() <= now.getTime()) {
    if (guard++ > 1000) return triggers.nextRun(trigger, now, { first: true });
    next = triggers.nextRun(trigger, next);
  }
  return next;
}

/**
 * Exécutions d'un déclencheur trop anciennes pour être gardées.
 *
 * L'index grossit sans intervention : un déclencheur horaire produit sept cents
 * conversations par mois. La purge n'est donc pas un confort mais la condition pour que
 * la sidebar et le disque restent tenables.
 *
 * Une conversation ayant des enfants n'est jamais rendue : la refuser ici évite d'appeler
 * une suppression qui serait de toute façon refusée par le store, et rend la règle
 * lisible au bon endroit.
 */
function expiredRuns(conversations, trigger, now, hasChildren) {
  if (!trigger.purgeAfterDays) return [];
  const cutoff = now.getTime() - trigger.purgeAfterDays * DAY_MS;
  return conversations.filter(
    (c) =>
      c.triggerId === trigger.id &&
      new Date(c.updatedAt).getTime() < cutoff &&
      !hasChildren(c.id)
  );
}

let timer = null;

/**
 * Démarre la boucle. `handlers` fournit les actions :
 * - `launch(trigger)` : crée l'exécution et lance son turn
 * - `purgeRun(convId)` : supprime une exécution et ses traces
 * - `save(trigger, patch)` : persiste l'avancement de l'échéance
 * - `sendPlanned(message)` : envoie un message planifié dans sa conversation, ou dans une
 *   copie forkée selon son mode
 * - `snapshot()` : renvoie `{ triggers, conversations, hasChildren }`
 */
function start(handlers) {
  stop();

  const tick = async () => {
    const now = new Date();
    let state;
    try {
      state = handlers.snapshot();
    } catch (err) {
      console.error(`planificateur : lecture d'état impossible (${err.message})`);
      return;
    }

    for (const trigger of due(state.triggers, now)) {
      // L'échéance est avancée avant de lancer : si le lancement échoue, le déclencheur
      // ne doit pas repartir en boucle à chaque tick.
      let next;
      try {
        next = reschedule(trigger, now);
      } catch (err) {
        console.error(`planificateur : échéance incalculable pour ${trigger.name} (${err.message})`);
        continue;
      }
      handlers.save(trigger, { nextRunAt: next ? next.toISOString() : null });

      if (!trigger.enabled) continue;

      try {
        await handlers.launch(trigger);
      } catch (err) {
        console.error(`planificateur : exécution impossible pour ${trigger.name} (${err.message})`);
      }
    }

    // Messages planifiés dans une conversation existante. Même boucle : ce qui décide
    // « quand » n'a pas de raison d'exister en double.
    for (const message of planned.due(now)) {
      try {
        await handlers.sendPlanned(message);
      } catch (err) {
        console.error(`planificateur : message planifié impossible (${err.message})`);
        planned.failed(message.id, err.message);
      }
    }
    try {
      planned.sweep((id) => state.conversations.some((c) => c.id === id), now);
    } catch (err) {
      console.error(`planificateur : nettoyage des messages planifiés (${err.message})`);
    }

    // La purge tourne à la même cadence : rien ne justifie une seconde boucle.
    for (const trigger of state.triggers) {
      for (const run of expiredRuns(state.conversations, trigger, now, state.hasChildren)) {
        try {
          await handlers.purgeRun(run.id);
        } catch (err) {
          console.error(`planificateur : purge impossible pour ${run.id} (${err.message})`);
        }
      }
    }
  };

  // Un tick immédiat au démarrage : c'est lui qui rattrape l'échéance manquée pendant
  // l'arrêt, sans attendre la première cadence.
  timer = setInterval(() => {
    tick().catch((err) => console.error(`planificateur : ${err.message}`));
  }, TICK_MS);
  // `unref` pour ne pas retenir le process à l'arrêt.
  if (timer.unref) timer.unref();

  return tick().catch((err) => console.error(`planificateur : ${err.message}`));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, due, reschedule, expiredRuns, TICK_MS };
