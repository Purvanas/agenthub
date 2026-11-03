# Évolutions des instantanés publics

## 2026-11-03

Cet instantané rassemble les évolutions issues de l'utilisation quotidienne d'agentHub. Le projet conserve son périmètre d'outil personnel adapté à un environnement serveur Linux.

- **Conversations longues** : pagination adaptée au mobile, index SQLite dérivé dans un worker, recherche et repères du fil, sorties d'outils complètes chargées à la demande.
- **Choix des modèles** : sélection du prochain message enregistrée avant l'envoi, configuration du tour actif figée et dernier relevé accompagné de sa provenance.
- **Espace de travail** : vues projets, décisions en attente, worktrees, archives, recherche avancée et suivi des budgets.
- **Continuité du travail** : brouillons et pièces jointes conservés, réponses tardives ignorées et transitions de file protégées contre pertes et doublons.
- **Maintenance** : contrôleurs HTTP par domaine, vues autonomes, rendu des messages séparé et guides d'architecture et de contribution.
- **Régressions** : scénarios HTTP/WebSocket, historique synthétique volumineux, arrêt/reprise d'un faux CLI détaché et contrôle du chargement des scripts ; CI Node.js 22 et 24.

Les configurations publiées utilisent des valeurs d'exemple et une écoute locale par défaut. Les données d'exécution et les paramètres personnels de l'installation d'origine ne font pas partie de cet instantané.
