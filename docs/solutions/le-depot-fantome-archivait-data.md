---
titre: Le dépôt fantôme archivait data/, et une restauration l'aurait réécrit
type: bug
date: 2026-07-31
---

## Symptôme

Le dossier `data/checkpoints/` gonflait (des centaines de Mo) pour quelques
conversations. Un seul dépôt fantôme suivait **des milliers de fichiers sous
`data/`** — dont les dépôts fantômes des autres conversations.

## Cause

Le work-tree d'un dépôt fantôme est le dossier de travail de la conversation. Quand ce
dossier est agentHub lui-même — ce qui arrive dès qu'on demande à un agent de travailler
sur l'app — `data/` est dedans, et `git add -A` l'archive.

La liste d'exclusions contenait bien `.git/`, mais les dépôts fantômes s'appellent
`<uuid>.git`. Un motif gitignore `.git/` ne correspond qu'à une entrée nommée exactement
`.git` : `34838e49-….git` passe à travers. Chaque instantané archivait donc l'état interne
des dépôts des autres conversations, y compris leurs fichiers `index.lock`.

## Ce qui était vraiment en jeu

Pas la place disque — la restauration. Un `reset --hard <sha>` sur un instantané contenant
`data/` remet les conversations, les images et les instantanés dans l'état de l'époque :
tout ce qui a été écrit depuis est réécrit. La règle « `data/` ne se touche pas » était
contournable par l'outil de l'application censé protéger les fichiers.

## Ce qui a été fait

1. `excludesFor(cwd)` ajoute `/<chemin relatif de data>/` à la liste quand le dossier de
   données est sous le dossier suivi. Le `/` initial ancre le motif à la racine du
   work-tree : un `data/` situé plus bas dans un projet suivi reste archivé, ce qui est le
   comportement attendu.
2. La liste d'exclusions est réécrite **à chaque instantané** et non à la seule création du
   dépôt, sinon les dépôts existants ne rattraperaient jamais le changement.
3. Un motif d'exclusion ne détache pas ce qui est déjà suivi : quand la liste change,
   `git rm -r --cached` détache le dossier de données. Les fichiers restent sur le disque,
   seul l'index les oublie.
4. Les instantanés **antérieurs** contiennent encore `data/`. Les restaurer reste dangereux,
   et rien ne peut le rendre sûr après coup : `restore` interroge donc `git ls-tree` et
   **refuse** si l'instantané visé contient le dossier de données, avec un message qui
   explique pourquoi.

## Vérifié

Sur un dossier jetable contenant son propre `data/` : le nouvel instantané ne suit que les
fichiers du projet ; le diff annonce exactement les fichiers modifiés et créés ; après
restauration le fichier modifié retrouve son contenu, le fichier créé disparaît, et un
fichier écrit dans `data/` entre-temps est **épargné**.

Sur un dépôt créé avec l'ancienne liste : le premier instantané suivant le détache et ne
suit plus que le projet, la restauration du vieux sha est refusée, celle d'un sha récent
fonctionne.

## Ce que ça apprend pour la suite

Un motif gitignore ne détache jamais ce qui est déjà suivi — l'ajouter ne suffit donc pas,
il faut toujours le doubler d'un `git rm --cached`. Et une exclusion qui dépend du dossier
de travail ne peut pas être une constante : elle doit être recalculée, et réappliquée aux
dépôts déjà créés.
