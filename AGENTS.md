# agentHub

Interface web qui pilote Claude Code, Codex et Grok Build. Conversations reprenables, relais entre agents, déclencheurs.

**`README.md` est la documentation de référence.**

## Comment ça tourne

- Entrée : `server.js`
- Écoute : `HOST` (défaut `127.0.0.1`) et `PORT` (défaut `3901`)
- PM2 : `agentHub` via `ecosystem.config.js` (`treekill: false`)
- Express et `ws`, sans framework front, sans étape de build

**Ne pas exposer sur Internet.** L'app exécute du code arbitraire avec les droits du compte.

## Après modification

```bash
npm run check
pm2 restart agentHub
```

Un turn en cours survit au redémarrage (`treekill: false` + flux fichier). `pm2 delete` puis `pm2 start server.js` perdrait ce réglage : passer par `ecosystem.config.js`.

## `data/` ne se touche pas

Conversations, images, journal de consommation, notes, worktrees. Hors git. Le supprimer perd l'historique.

`data/settings.json` : ce que la page Paramètres a changé, par-dessus `config/`. Ne jamais faire écrire l'UI dans `config/` : ça salirait le dépôt et casserait un déploiement `updateInstead`.

## Points qui surprennent

- Fuseau `Europe/Paris` via `AGENTHUB_TZ`, pour que « chaque jour à 7 h » veuille dire 7 h
- Fichiers statiques en `no-cache`
- Le planificateur vit dans le processus : un redémarrage traverse son état
