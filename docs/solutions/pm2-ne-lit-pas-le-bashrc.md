---
titre: PM2 ne lit pas le .bashrc, donc le binaire grok était introuvable
type: piege
date: 2026-07-31
---

## Symptôme

`grok` fonctionne parfaitement en SSH interactif. Lancé par agentHub sous PM2, il remonte
« introuvable » dans le fil de la conversation.

## Cause

L'installeur de Grok ajoute `~/.grok/bin` au `PATH` dans le `.bashrc`. PM2 ne lit pas le
`.bashrc` : il hérite de l'environnement du processus qui l'a démarré, pas d'un shell de
connexion. Le `PATH` vu par l'application ne contient donc pas ce dossier.

## Ce qui a été fait

Chemin absolu par défaut dans la table des fournisseurs de `lib/runner.js` :

```js
bin: () => process.env.AGENTHUB_GROK_BIN || 'grok',
```

## À retenir plus largement

Tout ce qui dépend du `PATH`, d'un alias ou d'une variable posée dans un fichier de shell
n'existe pas pour un processus PM2. Vérifier avec `pm2 env <id>` plutôt que de supposer que ce
qui marche en SSH marchera sous PM2. Le même piège vaut pour les tâches cron.
