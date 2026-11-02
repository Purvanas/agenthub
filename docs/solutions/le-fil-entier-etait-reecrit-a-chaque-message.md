---
titre: Le fil entier était réécrit à chaque message, en synchrone
type: mesure
date: 2026-07-31
---

## Ce qui a été mesuré

Le plus gros fil du serveur, 268 messages, sérialisé et écrit comme le faisait `store.js` :

| Étape | Durée |
|---|---|
| `JSON.stringify(conv, null, 2)` | 44 ms |
| `fs.writeFileSync` (9,2 Mo) | 21 ms |
| **total, boucle d'événements bloquée** | **65 ms** |

Toutes les 400 ms pendant qu'un agent produit, puisque c'est la cadence du flush.

## Pourquoi c'est le mauvais coût

Il est proportionnel à la **longueur du fil**, pas à ce qu'on ajoute. Une conversation de
mille messages bloquerait donc plusieurs centaines de millisecondes par flush, et le
symptôme apparaît précisément là où on ne veut pas de latence : dans les conversations
longues, celles qui ont de la valeur.

C'est aussi la faute que `lib/checkpoints.js` documente et s'interdit depuis un gel de 4,7 s
sur un instantané. Le raisonnement vaut pour `fs` comme pour `git` : rien de proportionnel à
la taille des données ne doit être synchrone dans ce processus.

## Ce qui a été fait

Métadonnées et messages séparés : `conv/<id>.json` d'un côté, `conv/<id>.jsonl` de l'autre,
une ligne par message. Ajouter un message est un `appendFileSync` de la taille du message.

Le point non évident : un message **change** après avoir été écrit — le résultat d'un outil
arrive après son appel, un avis se repeint en erreur quand le turn échoue. Réécrire le
journal à chaque fois aurait recréé exactement le problème, puisqu'un turn riche en outils
modifie un message presque aussi souvent qu'il en ajoute. La nouvelle version est donc
**ajoutée à la fin**, et la relecture applique la dernière version de chaque identifiant à
la place de sa première apparition (ce que `Map` garantit). Écriture O(1) dans tous les cas.

Le journal se compacte à la lecture s'il dépasse trois fois le nombre de messages réels — en
régime normal un message d'outil est écrit deux fois, le seuil laisse donc cette marge.

## Effet de bord utile

Une ligne tronquée par un crash en pleine écriture fait perdre ce message-là et pas le fil,
là où un JSON tronqué rendait tout le fichier illisible. C'est le même raisonnement que
`usage.jsonl`, qui était déjà append-only pour cette raison.

## Piège rencontré en écrivant les tests

Un test qui supprime son dossier temporaire à la fin déclenchait une exception non
capturée : le flush différé de 400 ms se réveillait après coup et écrivait dans un dossier
disparu. En production ce n'est pas le dossier qui disparaît, mais le constat vaut quand
même — une exception dans un minuteur n'est rattrapée par personne et **emporte le
processus**, donc toutes les conversations en cours, pour un fichier qu'on n'a pas su
écrire. `flush` attrape et journalise désormais.
