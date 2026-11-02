'use strict';

// Écouter, en attendant l'adresse s'il le faut.
//
// agentHub se lie à une adresse précise et non à `0.0.0.0` : il exécute du code
// arbitraire, il n'a rien à faire sur le réseau entier. Au démarrage, PM2 peut partir
// avant que l'interface d'écoute (VPN, alias) n'existe — `listen` échoue alors en
// `EADDRNOTAVAIL`, et le processus meurt.
//
// Ce module réessaie au lieu d'abandonner. Le repli qu'on **ne fait pas**, et qu'il faut
// écarter explicitement : basculer sur `0.0.0.0` quand l'adresse manque. Ce serait exposer au
// réseau entier une application qui lance des agents en autonomie totale — un incident de
// sécurité déguisé en robustesse.

/** Échecs de `listen` qui valent la peine d'attendre. */
const RETRYABLE = new Set([
  // L'adresse n'est pas (encore) portée par une interface.
  'EADDRNOTAVAIL',
  // Le port est encore tenu, typiquement par l'instance précédente qui n'a pas fini de
  // s'arrêter — `kill_timeout` lui laisse cinq secondes pour vider ses écritures.
  'EADDRINUSE',
]);

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;

/** Ce code d'erreur justifie-t-il d'attendre plutôt que de mourir ? */
function retryable(code) {
  return RETRYABLE.has(String(code || ''));
}

/** Attente suivante : croissance douce, puis palier. Sans plafond, on finirait en heures. */
function nextDelay(current, max = MAX_DELAY_MS) {
  return Math.min(Math.round(current * 1.5), max);
}

/**
 * Lie le serveur, en réessayant tant que l'adresse n'est pas disponible.
 *
 * **Sans abandon volontaire.** Sortir ferait reprendre la boucle à PM2, dont le
 * `max_restarts` finirait par renoncer pour de bon — l'application resterait éteinte alors
 * que la seule chose à faire était d'attendre. On boucle donc ici, en le disant dans le
 * journal : une attente visible vaut mieux qu'un abandon silencieux.
 *
 * Une erreur non listée dans `RETRYABLE` passe à `onFatal`, qui par défaut la relance : un
 * port refusé par les droits, par exemple, ne se règlera pas tout seul et doit se voir. Le
 * relais existe parce qu'une erreur de `listen` arrive en **événement**, pas en jet
 * synchrone — sans lui, le cas fatal serait invérifiable autrement qu'en faisant tomber le
 * process du test.
 *
 * @param {import('net').Server} server
 * @param {{port: number, host: string, onListening: Function, onWait?: Function,
 *          onFatal?: Function, firstDelayMs?: number, maxDelayMs?: number}} opts
 * @returns {{stop: Function}} de quoi arrêter les tentatives — pour les tests
 */
function listenWithRetry(server, opts) {
  const { port, host, onListening } = opts;
  const maxDelay = opts.maxDelayMs || MAX_DELAY_MS;
  const onFatal =
    opts.onFatal ||
    ((err) => {
      throw err;
    });
  let delay = opts.firstDelayMs || FIRST_DELAY_MS;
  let attempts = 0;
  let timer = null;
  let stopped = false;

  const onError = (err) => {
    if (!retryable(err && err.code)) return onFatal(err);
    attempts += 1;
    if (opts.onWait) opts.onWait({ code: err.code, attempts, delay });
    if (stopped) return;
    timer = setTimeout(() => server.listen(port, host), delay);
    delay = nextDelay(delay, maxDelay);
  };

  server.on('error', onError);
  server.once('listening', () => {
    // Le gestionnaire de reprise ne vaut que pour la mise en écoute. Le retirer rend à Node
    // son comportement normal — une erreur de serveur en fonctionnement doit se voir.
    server.removeListener('error', onError);
    onListening({ attempts });
  });

  server.listen(port, host);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      server.removeListener('error', onError);
    },
  };
}

module.exports = { RETRYABLE, FIRST_DELAY_MS, MAX_DELAY_MS, retryable, nextDelay, listenWithRetry };
