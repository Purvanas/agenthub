# agentHub

Interface web pour piloter plusieurs agents de code — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) et [Grok Build](https://x.ai) — depuis un seul endroit.

Chaque conversation est une vraie session CLI. Le premier message la crée, les suivants la reprennent. Pas d'émulation de terminal, pas de `/resume` à taper : le serveur traduit le JSONL des CLIs en fil de discussion (texte, réflexion, appels d'outils, erreurs).

## Ce que ça fait

- **Plusieurs agents, une sidebar** — Claude, Codex, Grok, avec l'état de chaque conversation (en cours, terminé, erreur, interrompu).
- **Relais** — passer une conversation d'un agent à un autre sans perdre le contexte.
- **Déclencheurs** — cron, rapport par mail, enchaînements.
- **Worktrees** — une branche git isolée par conversation.
- **Consommation** — tokens et coût, par provider, modèle, semaine et projet.
- **Mémoire de projet** — leçons réinjectées dans les turns suivants.
- **Notes, plans, idées, questions** — l'agent peut poser une question et attendre la réponse humaine.
- **Navigateur** — optionnel, via un serveur MCP Playwright qui tourne à côté.
- **MCP intégré** — agentHub expose lui-même des outils (ask, notes, plans, connexions).

Le front est du HTML / CSS / JS vanilla. Pas d'étape de build.

## Lancer

Node 18 ou plus. Les CLIs (claude, codex, grok) doivent être installés et authentifiés sur la machine.

```bash
npm ci
npm test
HOST=127.0.0.1 PORT=3901 npm start
```

Ouvre [http://127.0.0.1:3901](http://127.0.0.1:3901).

**Ne pas exposer ce service sur Internet.** Il lance des agents qui exécutent du code avec les droits du compte. Le bind par défaut est `127.0.0.1`. Place-le derrière un VPN (Tailscale, WireGuard) si tu y accèdes à distance.

## Configuration

Les fichiers de `config/` sont relus à chaque usage, sans redémarrage.

| Fichier | Rôle |
|---|---|
| `groups.json` | Groupes du sélecteur de dossier |
| `models.json` | Entrées du menu Modèle |
| `pricing.json` | Tarifs API, pour les CLIs qui ne chiffrent pas eux-mêmes |
| `notify.json` | Notifications (ntfy / webhook) |
| `browser.json` | Serveur MCP Playwright des agents |
| `connections.json` | Navigateur humain temporaire (Playwright) |
| `memory.json` | Mémoire de projet |
| `mail.example.json` | Copier en `mail.json` pour l'envoi SMTP |

`config/mail.json` n'est **pas** versionné : il contient un mot de passe. Sans lui, l'envoi par mail est simplement indisponible.

La page **Paramètres** écrit dans `data/settings.json`, par-dessus ces défauts. `data/` est l'état de l'application (conversations, journal de consommation, worktrees) et reste hors git.

### Variables d'environnement utiles

| Variable | Défaut | Rôle |
|---|---|---|
| `HOST` | `127.0.0.1` | Adresse d'écoute |
| `PORT` | `3901` | Port |
| `AGENTHUB_GROK_BIN` | `grok` | Binaire Grok |
| `AGENTHUB_MCP_URL` | `http://HOST:PORT/mcp` | Racine MCP d'agentHub |
| `AGENTHUB_GOOGLE_REDIRECT_URI` | — | Callback OAuth Google |

## PM2

`ecosystem.config.js` pose `treekill: false` : un `pm2 restart` ne tue pas un turn en cours. Le flux du CLI passe par un fichier, pas un pipe, pour la même raison.

```bash
pm2 start ecosystem.config.js
pm2 save
```

Ne pas lancer avec `pm2 start server.js` : tu perds `treekill: false`.

## Tests

```bash
npm test
npm run check   # syntaxe + tests
```

## Licence

MIT.
