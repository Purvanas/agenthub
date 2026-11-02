// Configuration PM2 d'agentHub.
//
// Elle existe pour une seule raison, qui ne se devine pas : `treekill: false`.
//
// Par défaut PM2 tue tout l'arbre du processus à l'arrêt. Un turn en cours mourait donc avec
// l'application, et un `pm2 restart` — la procédure normale de déploiement — perdait le
// travail de l'agent. Mesuré le 03/08/2026 : le processus `claude` était bien mort, et sa
// trace figée.
//
// `treekill: false` ne suffit pas à lui seul, et pris seul il **empire** les choses : le CLI
// survit mais se bloque, son `stdout` pointant vers un tuyau dont plus personne ne lit. C'est
// pourquoi le flux passe maintenant par un fichier (`lib/inflight.js`) : un fichier ne se
// ferme pas quand son lecteur disparaît. Les deux vont ensemble — changer l'un sans l'autre
// casse la reprise.
//
// Déploiement : `pm2 start ecosystem.config.js` puis `pm2 save`. Un simple
// `pm2 restart agentHub` conserve ensuite ces réglages.

module.exports = {
  apps: [
    {
      name: 'agentHub',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',

      // Le point de tout ce fichier : ne pas emporter les turns en cours.
      treekill: false,

      // Laisse le temps d'écrire l'index et les métadonnées en attente avant de partir.
      // `SIGTERM` déclenche `store.flush()` dans `server.js`.
      kill_timeout: 5000,

      // Les journaux de l'application ; ceux des turns vivent dans `data/turns/`.
      merge_logs: true,
      time: true,
    },
  ],
};
