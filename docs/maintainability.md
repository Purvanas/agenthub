# Maintenir agentHub

Ce guide indique où intervenir sans recréer de couplage, et quels contrats préserver pendant une évolution. Il complète [l'architecture](architecture.md) et les retours d'expérience de [`docs/solutions`](solutions/README.md).

## Trouver le bon propriétaire

| Besoin | Point de départ | À éviter |
|---|---|---|
| Route ou payload HTTP | contrôleur du domaine dans `lib/http/` | accès direct à `data/` depuis la route |
| Règle métier ou persistance | module concerné dans `lib/` | dupliquer la règle dans `server.js` |
| Préparation ou exécution d'un tour | `turn-preparation.js`, file, runner et reprise | relire un réglage mutable après la mise en file |
| Modèle ou fournisseur | catalogue, `model-selection.js`, runner, puis sélecteur | modifier uniquement le DOM |
| Vue autonome | fabrique `create(deps)` dans `public/` | ajouter un nouvel état global à `app.js` |
| Rendu d'un message | `public/message-renderer.js` | lire implicitement la conversation courante |
| Contexte projet | plans, règles, notes, mémoire ou prompts | fusionner des sources aux cycles de vie différents |
| Préférence utilisateur | `lib/settings.js` et contrôleur Paramètres | écrire dans `config/` depuis l'interface |

## Ajouter une route

1. Choisir le domaine propriétaire et son contrôleur HTTP.
2. Injecter le service qui porte les règles ou les effets externes.
3. Garder dans la route la validation d'entrée, la traduction HTTP et la diffusion.
4. Préserver les routes, les payloads et les événements WebSocket déjà publics.
5. Couvrir le contrat avec des dépendances contrôlées ; réserver les scénarios réels aux parcours qui traversent réellement HTTP ou WebSocket.

Un contrôleur doit pouvoir être chargé sans démarrer le serveur. Son état transitoire, s'il en possède un, reste privé à son instance.

## Ajouter ou modifier une vue

Une vue autonome expose `window.AgentHubNomView = Object.freeze({ create })`. La fabrique reçoit ses dépendances et retourne seulement les opérations nécessaires au coordinateur.

- Résoudre le DOM au montage, pas au chargement du script.
- Conserver sélection, chargement et jetons de requête dans le contrôleur.
- Invalider une réponse si la vue, le projet ou la conversation a changé.
- Injecter les dialogues, le client API et les utilitaires partagés.
- Garder le renderer de messages pur et lui passer `{ conversationId }` explicitement.

Les scripts classiques partagent leur espace global. Encapsuler un nouveau module et éviter d'introduire un nom global déjà déclaré dans un autre script chargé par `index.html`.

## Faire évoluer les conversations

Les journaux JSONL sont la source de vérité. Une évolution de lecture peut créer un index, un cache ou une projection, à condition qu'ils soient dérivés et reconstruisibles.

- Ajouter les événements au journal au lieu de réécrire tout le fil.
- Paginer avec des identifiants stables ; un nouveau message ne doit pas déplacer les ancres existantes.
- Ne transporter qu'un aperçu borné d'une sortie volumineuse, puis charger le contenu complet sur demande.
- Ne jamais réparer un index en réécrivant les JSONL.
- Préserver les formats persistés ou fournir une migration compatible avec les données existantes.

## Ajouter un modèle ou un fournisseur

L'intégration traverse le catalogue, les comptes, la validation serveur, le runner, la reprise, les métriques et l'interface. Le serveur reste l'autorité sur le choix effectif.

L'interface distingue trois états : configuration du prochain message, snapshot du tour en cours et dernier relevé avec sa provenance. Elle enregistre un changement avant l'envoi et ne présente pas un défaut de CLI inconnu comme une version confirmée.

## Validation proportionnée

Le workflow GitHub Actions est configuré pour exécuter `npm run check` sur Node.js 22 et 24. La commande inclut les contrats unitaires et les scénarios critiques HTTP, WebSocket et reprise avec de faux CLIs déterministes.

Quand ces checks distants sont disponibles :

1. relire le diff et les fichiers touchés ;
2. pousser la branche sans répéter la chaîne complète localement ;
3. examiner les deux jobs Node et diagnostiquer seulement un éventuel échec ;
4. vérifier manuellement le parcours directement touché lorsque l'ergonomie est en jeu.

Les régressions à traiter explicitement sont notamment l'ouverture mobile d'un long fil, la navigation pendant une requête lente, l'enregistrement du modèle avant envoi, la reprise après redémarrage et la reconnexion WebSocket.

## Dette à surveiller

- `server.js` et `public/app.js` restent des coordinateurs volumineux : extraire par domaine observable, pas par simple taille de fichier.
- Le planificateur partage le processus web : préserver le rattrapage et l'idempotence au redémarrage.
- Le navigateur partagé n'est pas une session isolée par conversation.
- L'exposition réseau est une frontière de sécurité : ne pas changer le défaut localhost sans décision explicite.
