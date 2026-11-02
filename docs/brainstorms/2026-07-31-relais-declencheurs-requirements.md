---
date: 2026-07-31
topic: relais-declencheurs
---

# Relais entre agents et déclencheurs planifiés

## Summary

Deux ajouts à agentHub. Un bouton **Relais** qui dérive une conversation vers un autre
agent ou un autre modèle, en créant une conversation enfant imbriquée sous son parent,
sans consommer le parent. Une section **Déclencheurs** où un agent part seul à heure
fixe sur un dossier, chaque exécution atterrissant dans un dossier repliable au nom du
déclencheur, avec son coût suivi.

---

## Problem Frame

Enchaîner deux agents sur une même tâche est aujourd'hui abandonné plutôt que pénible :
interrogé sur ce qu'il fait quand il veut qu'un autre agent reprenne un travail entamé,
l'utilisateur répond « je ne le fais pas, c'est trop pénible ». Le contournement
occasionnel consiste à coller un identifiant de session dans le prompt du second agent
— « tiens, continue le travail de 019f6aff-… » — en espérant qu'il retrouve et
comprenne le transcript d'un concurrent.

Le coût de ce renoncement est direct. Le bon découpage économique est connu : concevoir
avec le modèle le plus capable, exécuter avec le plus rapide et le moins cher. Mesuré
sur ce serveur, un même prompt trivial coûte 4,2 fois moins de tokens de sortie chez
Grok que chez Opus, à tarif deux à quatre fois inférieur. Sans mécanisme de passation,
ce découpage n'est jamais appliqué et tout se fait avec un seul agent.

Le second manque est de nature différente : le serveur tourne en permanence, mais rien
n'y déclenche d'agent. Les vérifications récurrentes se font à la main quand
l'utilisateur y pense, alors que le crontab de la machine porte déjà cinq tâches
planifiées pour des besoins voisins.

---

## Key Decisions

**La passation voyage par fichier, pas par le fil.** Transmettre la conversation
complète est impossible dans le cas général : Opus 5 dispose de 1 M de contexte, Grok
Build de 500 K. Un fil de 800 K ne rentre pas, et même quand il rentre, on paie en
entrée l'intégralité de l'historique — y compris chaque `ls` et chaque lecture de
fichier — pour une session neuve où le cache n'aide pas. Le prompt de l'enfant reste
donc court et pointe vers un fichier ; c'est l'agent entrant qui décide de ce qu'il lit,
avec son propre outil de lecture.

**Même fournisseur : fork de session. Fournisseur différent : note de passation.**
Rester chez le même éditeur permet de repartir de la session du parent avec un contexte
complet et une fidélité parfaite, sans rien réexpliquer. Traverser vers un autre
fournisseur impose de fabriquer une charge utile, et c'est l'agent sortant qui l'écrit
— lui seul sait ce qui compte dans ce qu'il vient de faire.

**Le relais crée toujours une conversation enfant, jamais une continuation en place.**
Le parent conserve son contexte et reste dérivable : c'est ce qui permet de tenir un
Opus qui a bien compris le projet et d'en lancer plusieurs Haiku en parallèle. Un
parent, N enfants.

**Une conversation par exécution de déclencheur.** Un fil unique qui accumule les
exécutions garderait la mémoire des passages précédents, mais son contexte gonflerait
sans fin — quelques semaines plus tard le coût d'entrée devient prohibitif, puis la
fenêtre déborde. Le contexte neuf à chaque exécution garde un coût stable et un
historique consultable.

**Observabilité plutôt qu'application, sur le coût des déclencheurs.** Un seuil de
quota qui saute silencieusement une exécution est un pire défaut que l'absence de
garde-fou : mal réglé, il désactive le déclencheur sans le dire. On montre donc ce que
coûte un déclencheur et on laisse l'utilisateur arbitrer.

---

## Actors

- A1. **L'utilisateur** — déclenche un relais, configure un déclencheur, consulte les coûts.
- A2. **L'agent sortant** — celui dont on dérive ; écrit la note de passation en cas de relais croisé.
- A3. **L'agent entrant** — celui qui reprend, dans la conversation enfant.
- A4. **Le planificateur** — mécanisme interne qui déclenche les exécutions à l'heure dite.

---

## Requirements

**Relais — déclenchement et fenêtre**

- R1. Une conversation expose une action « Relais » qui ouvre une fenêtre modale, sans quitter la conversation courante.
- R2. La fenêtre propose deux points de départ : repartir d'un **fichier** choisi, ou repartir de la **conversation**.
- R3. Le choix de fichier est une liste courte, pas un explorateur de système de fichiers : les fichiers markdown créés ou modifiés pendant la conversation, dérivés des instantanés git existants, plus une saisie libre de chemin en repli.
- R4. La fenêtre propose deux listes déroulantes : le **fournisseur** (Claude, Codex, Grok) puis le **modèle**, cette seconde liste dépendant du fournisseur choisi.
- R5. Une consigne par défaut est pré-remplie de sorte que le relais puisse se faire sans rien écrire ; un champ texte court permet de la remplacer.

**Relais — mécanique de passation**

- R6. Relais vers le **même fournisseur** : la conversation enfant reprend la session du parent en la forkant, avec le modèle choisi. Aucune note de passation n'est produite, aucun contexte n'est réexpliqué.
- R7. Relais vers un **fournisseur différent** : l'agent sortant produit d'abord une note de passation structurée — objectif, décisions prises, ce qui reste à faire, pièges, fichiers touchés — écrite dans un fichier, puis la conversation enfant démarre en pointant vers ce fichier.
- R8. Le parent n'est jamais modifié ni consommé par un relais, et reste dérivable autant de fois que voulu.
- R9. Le fork de session n'est pas disponible chez tous les fournisseurs. Quand il manque, le relais vers le même fournisseur emprunte le chemin de la note de passation (R7) plutôt que d'avancer la session du parent.

**Relais — affichage dans la sidebar**

- R10. Une conversation enfant est une conversation ordinaire, marquée comme enfant d'une autre. Aucun comportement serveur ne la distingue.
- R11. La sidebar imbrique les enfants sous leur parent, dépliables par une flèche, comme un sous-dossier.
- R12. Quand le filtre par agent masque le parent mais pas l'enfant, l'enfant s'affiche seul à la racine avec la mention de sa provenance. Le filtre conserve ainsi un sens simple.
- R13. Une conversation qui a des enfants n'est jamais supprimée automatiquement. Supprimée à la main, ses enfants remontent à la racine avec la mention que leur parent n'existe plus.

**Déclencheurs — configuration**

- R14. Une section dédiée liste les déclencheurs et permet d'en créer.
- R15. Un déclencheur porte : un fournisseur, un modèle, un dossier de travail, un prompt, une heure de déclenchement et une fréquence.
- R16. Un déclencheur peut être désactivé sans être supprimé.
- R17. Un déclencheur porte une option « interrompre au-delà de » avec une durée : l'exécution qui dépasse est arrêtée et marquée comme telle.
- R18. Un déclencheur porte un délai de purge : ses exécutions plus anciennes sont supprimées automatiquement, avec leurs images et leurs instantanés, sous réserve de R13.

**Déclencheurs — exécution et suivi**

- R19. Chaque exécution crée une conversation, rangée dans un dossier de la sidebar portant le nom du déclencheur.
- R20. Une exécution est une conversation ordinaire : elle peut être relue, poursuivie à la main, et faire l'objet d'un relais.
- R21. La liste des déclencheurs affiche, par déclencheur, le **coût total** et le **coût moyen par exécution**.
- R22. La liste des déclencheurs affiche l'état de la dernière exécution et la date de la prochaine.

---

## Key Flows

- F1. **Planifier avec Opus, exécuter avec Grok**
  - **Trigger :** A1 a obtenu un plan satisfaisant dans une conversation Opus.
  - **Steps :** A1 ouvre le relais ; choisit « repartir d'un fichier » et sélectionne le plan dans la liste courte ; choisit Grok puis son modèle ; valide. A2 n'est pas sollicité, le fichier existe déjà. La conversation enfant démarre avec une consigne courte pointant vers le plan.
  - **Outcome :** deux conversations liées, la Opus intacte, la Grok en train d'exécuter.
  - **Covered by :** R1, R2, R3, R4, R5, R8, R10, R11

- F2. **Dériver plusieurs exécutants d'un même parent**
  - **Trigger :** A1 veut confier trois parties d'un plan à trois agents.
  - **Steps :** A1 relaie une première fois depuis la conversation Opus ; le parent reste inchangé ; A1 relaie une seconde puis une troisième fois depuis la même conversation.
  - **Outcome :** un parent, trois enfants imbriqués sous lui, chacun avec sa propre session, son coût et sa jauge de contexte.
  - **Covered by :** R6, R8, R10, R11

- F3. **Relais croisé sans fichier préexistant**
  - **Trigger :** A1 veut passer à un autre fournisseur une conversation dont le travail n'a pas été écrit dans un fichier.
  - **Steps :** A1 choisit « repartir de la conversation » et un fournisseur différent. A2 produit la note de passation dans un fichier. La conversation enfant démarre en pointant vers cette note.
  - **Outcome :** A3 reprend sans que le fil complet ait été transmis ; la note reste disponible et réutilisable.
  - **Covered by :** R2, R7, R9

- F4. **Une exécution planifiée trouve quelque chose**
  - **Trigger :** A4 atteint l'heure de déclenchement.
  - **Steps :** une conversation est créée dans le dossier du déclencheur et l'agent travaille ; l'exécution se termine, ou est interrompue si elle dépasse la durée configurée.
  - **Outcome :** la conversation apparaît non lue dans le dossier ; A1 la lit plus tard et peut la relayer pour corriger ce qui a été trouvé.
  - **Covered by :** R17, R19, R20, R21, R22

---

## Acceptance Examples

- AE1. **Covers R6, R8.** Étant donné une conversation Opus, quand A1 relaie vers Haiku chez le même fournisseur, alors la conversation enfant dispose du contexte complet du parent sans qu'aucune note ait été produite, et le parent reste dérivable une seconde fois.
- AE2. **Covers R7.** Étant donné une conversation Opus sans fichier de plan, quand A1 relaie vers Grok, alors A2 écrit d'abord une note de passation dans un fichier et le prompt de l'enfant se contente d'y renvoyer.
- AE3. **Covers R9.** Étant donné un fournisseur dépourvu de fork de session, quand A1 relaie vers ce même fournisseur, alors la passation emprunte le chemin de la note et la session du parent n'est pas avancée.
- AE4. **Covers R12.** Étant donné un parent Claude et son enfant Grok, quand A1 masque Claude dans le filtre, alors l'enfant s'affiche seul à la racine avec la mention de sa provenance.
- AE5. **Covers R13, R18.** Étant donné une exécution de déclencheur plus ancienne que le délai de purge et pourvue d'un enfant issu d'un relais, quand la purge s'exécute, alors ni le parent ni l'enfant ne sont supprimés.
- AE6. **Covers R17.** Étant donné un déclencheur configuré pour interrompre au-delà d'une heure, quand une exécution dépasse cette durée, alors le groupe de processus est arrêté et la conversation marquée comme interrompue.
- AE7. **Covers R3.** Étant donné une conversation ayant modifié deux fichiers markdown, quand A1 ouvre le sélecteur de fichier, alors ces deux fichiers sont proposés sans qu'aucun autre emplacement du serveur soit parcouru.

---

## Scope Boundaries

**Reporté**

- Le duel A/B — lancer le même prompt sur plusieurs agents puis comparer. Écarté faute d'arbitre satisfaisant : sans juge automatique, l'utilisateur se retrouve à faire la revue manuelle de deux diffs, exactement ce qu'il refuse.
- Les notifications push — reprises plus tard sous forme d'activation par conversation, pour éviter le harcèlement du téléphone.
- Le garde-fou de quota sur les déclencheurs, et le plafond de coût par exécution. Remplacés par l'interruption au-delà d'une durée et le suivi de coût.
- Le fan-out multi-projets (une tâche, N dépôts).

**Hors périmètre**

- Rembobiner la conversation d'un agent. Déjà écarté en amont : le rewind natif n'est pas accessible hors interface interactive, et réécrire l'arbre de session d'un fournisseur est un format privé non documenté.

---

## Dependencies / Assumptions

- Le fork de session est disponible chez Claude et chez Grok, absent chez Codex — vérifié sur les versions installées. R9 existe pour cette raison.
- Les instantanés git par turn, déjà en place, fournissent gratuitement la liste des fichiers modifiés dont dépend R3.
- Le suivi de consommation par modèle avec coût, déjà en place, fournit la matière de R21. L'attribution d'une exécution à son déclencheur reste à établir.
- Le serveur porte déjà cinq tâches cron. Le mécanisme de planification de R15 peut s'appuyer sur ce pattern établi ou vivre dans l'application ; le choix relève du plan.
- Risque accepté par l'utilisateur : le PC et le serveur partagent le même compte Claude. Un déclencheur nocturne sur un modèle coûteux peut donc entamer le quota nécessaire à la journée de travail, sans qu'aucun mécanisme ne l'en empêche.

---

## Outstanding Questions

**À résoudre pendant la planification**

- Attribution d'une exécution à son déclencheur dans le journal de consommation : le journal porte l'identifiant de conversation, pas celui du déclencheur.
- Emplacement des fichiers de note de passation : dans le dossier de travail, visible et versionnable mais polluant le dépôt, ou dans les données de l'application, propre mais hors du champ de vision de l'utilisateur.
- Mécanisme de planification : crontab de la machine, timer systemd, ou planificateur interne au processus. Chacun a des conséquences différentes sur la survie au redémarrage.
- Expression de la fréquence : présélections lisibles (chaque jour à telle heure, chaque semaine) ou expression cron complète.
