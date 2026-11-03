# agentHub

Interface web personnelle pour piloter Claude Code, Codex et Grok Build. Le [README](README.md) présente le produit ; [docs/architecture.md](docs/architecture.md) décrit les frontières du code.

## Carte du code

| Zone | Responsabilité |
|---|---|
| `server.js` | Composition d'Express, du WebSocket et des services ; orchestration transverse. |
| `lib/http/` | Adaptation HTTP par domaine : validation, statuts et diffusion. |
| `lib/` | Règles métier, persistance, exécution des CLIs, reprise, recherche et intégrations. |
| `public/` | Interface sans framework ; vues isolées, navigation et rendu des messages. |
| `test/` | Contrats unitaires, courses du front et scénarios HTTP/WS/reprise avec faux CLIs. |
| `config/` | Valeurs par défaut versionnées. Les préférences de l'interface vont dans `data/settings.json`. |

Avant une modification transversale, lire aussi le [guide de maintenance](docs/maintainability.md) et les retours d'expérience de [`docs/solutions`](docs/solutions/README.md).

## Invariants

- `HOST` écoute par défaut sur `127.0.0.1` et `PORT` sur `3901`. Ne pas élargir cette exposition par défaut : les agents exécutent du code avec les droits du compte hôte.
- `data/` contient l'état utilisateur et n'est ni jetable ni régénérable. Ne jamais l'écraser, le déplacer ou l'ajouter à Git.
- Les journaux JSONL sont la source de vérité des conversations. L'index SQLite est un dérivé recréable ; une migration d'index ne doit pas réécrire les journaux.
- L'interface écrit ses préférences dans `data/settings.json`, jamais dans `config/`.
- Un tour fige son modèle et ses paramètres avant le lancement. Une modification ultérieure concerne le prochain message.
- Une vue ou une requête asynchrone ne doit pas repeindre une conversation devenue inactive.
- Un redémarrage persistant passe par `ecosystem.config.js` : `treekill: false` et le flux fichier fonctionnent ensemble pour permettre la reprise d'un tour.

## Choisir la bonne frontière

- Route ou payload HTTP : contrôleur du domaine dans `lib/http/`, sans accès direct à `data/`.
- Règle métier ou persistance : module dédié de `lib/`, avec effets externes injectés lorsqu'ils doivent être testés.
- Modèle ou fournisseur : catalogue, `lib/model-selection.js`, runner, puis interface de sélection ; ne pas coder un choix seulement dans le DOM.
- Vue autonome : fabrique `create(deps)` dans `public/`. Le rendu d'un message appartient à `public/message-renderer.js` et reçoit explicitement sa conversation.
- État transverse et câblage : `server.js` ou `public/app.js`. Ne pas y dupliquer une règle déjà possédée par un domaine.

## Validation et livraison

La CI est configurée pour exécuter `npm run check` sur Node.js 22 et 24 pour les pushes et les pull requests. Quand ces checks distants sont disponibles, ne pas les dupliquer localement : relire le diff, pousser, puis examiner les résultats GitHub. N'exécuter localement qu'une validation ciblée demandée ou nécessaire pour diagnostiquer un échec.

Préserver les contrats HTTP, les événements WebSocket et les formats persistés pendant une extraction. Toute modification de persistance doit rester compatible avec les données existantes et conserver les JSONL intacts.
