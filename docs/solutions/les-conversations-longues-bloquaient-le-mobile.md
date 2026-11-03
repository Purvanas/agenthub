---
titre: Les conversations longues bloquaient l'ouverture sur mobile
type: decision
date: 2026-11-03
---

# Les conversations longues bloquaient l'ouverture sur mobile

## Symptôme

Ouvrir une conversation ancienne pouvait laisser l'interface mobile attendre longtemps avant d'afficher quoi que ce soit. Le parcours chargeait le fil complet, y compris les sorties d'outils volumineuses, alors que l'utilisateur voulait d'abord retrouver les échanges récents.

Le coût se cumulait à trois endroits : lecture du journal, sérialisation HTTP et traitement/rendu dans le navigateur. Optimiser seulement le DOM aurait laissé les deux premiers coûts intacts.

## Choix retenu

Le journal JSONL reste la source de vérité et n'est pas réécrit. Un worker séparé maintient un index SQLite dérivé avec les positions, identifiants et offsets utiles. Le thread HTTP lui demande une fenêtre du fil au lieu de charger toute la conversation.

- la première requête charge les 50 derniers éléments sur mobile et 100 sur bureau ;
- les pages précédentes sont demandées à partir de l'identifiant du premier élément visible ;
- un résultat de recherche peut ouvrir une fenêtre centrée sur l'élément trouvé ;
- une sortie d'outil est limitée à un aperçu de 6 000 caractères dans une page ;
- le résultat complet possède un endpoint dédié et n'est chargé qu'après une action explicite.

Les ancres sont des identifiants d'items, pas des numéros de page. L'arrivée de nouveaux événements ne décale donc pas une page plus ancienne pendant sa lecture.

## Pourquoi un index dérivé

Le JSONL conserve les propriétés utiles à l'écriture : ajout séquentiel, format inspectable et reprise simple. SQLite apporte les requêtes de position et de recherche sans devenir une seconde source de vérité.

Le worker reconstruit ou complète l'index depuis le journal. Une base absente ou reconnue comme corrompue peut être supprimée puis recréée ; les JSONL ne sont jamais modifiés par ce chemin. Le travail SQLite reste hors de la boucle d'événements qui sert HTTP et WebSocket.

## Contrat de régression

Le scénario critique démarre un vrai serveur avec des faux CLIs déterministes, crée un historique synthétique volumineux puis vérifie le parcours HTTP : pages bornées et sans doublon, aperçu tronqué, récupération différée du résultat complet et empreinte du journal source inchangée.

Ce contrat protège la propriété importante : une optimisation de lecture ne doit ni perdre, ni réordonner, ni réécrire l'historique conservé.
