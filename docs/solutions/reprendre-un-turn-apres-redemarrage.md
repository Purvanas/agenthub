---
type: architecture
sujet: survie d'un turn à un redémarrage du serveur
mesuré: 2026-08-03
---

# Pourquoi un turn ne survit pas à un redémarrage, et ce qu'il faudrait

## Le symptôme

Un `pm2 restart agentHub` pendant qu'un agent travaille laisse la conversation en erreur avec
un avis dans le fil. Le travail en cours est perdu.

Conséquence concrète : agentHub ne peut pas se mettre à jour lui-même. Un agent qui modifie
agentHub, le redémarre, puis veut constater ses changements perd sa propre session au
redémarrage.

## Ce que le message disait, et qui était faux

L'avis affirmait que « l'agent lancé a pu continuer à travailler côté système ». **Mesuré le
03/08/2026 : c'est faux.**

Protocole : un turn lançant `for i in 1..10; do echo etape $i >> trace.txt; sleep 8; done`,
un `pm2 restart` au milieu, puis observation du PID et de `trace.txt`.

Résultat : le processus `claude` était mort, et `trace.txt` figé à 4 lignes. PM2 tue **tout
l'arbre** — `treekill: true` est son défaut — et le `detached: true` du `spawn` n'y change
rien : il crée une nouvelle session, pas une immunité aux signaux envoyés à l'arbre.

## La demi-mesure qui empire les choses

`pm2 start --no-treekill` fait bien survivre le processus. Vérifié : après le redémarrage, le
PID était toujours là.

Mais `trace.txt` ne progressait plus. Le CLI écrit son flux JSON sur `stdout`, qui était un
**tuyau** vers l'agentHub désormais mort. Plus personne ne lit à l'autre bout : le CLI se
bloque à la première écriture qui remplit le tampon.

On échange donc un processus tué proprement contre un processus bloqué qui tient sa session
et que l'application ne peut plus ni suivre ni interrompre — elle a perdu son descripteur.
C'est pire. `treekill: true` a été rétabli.

## Ce qu'il faut, et pourquoi les deux ensemble

| | Sans | Avec |
|---|---|---|
| `treekill: false` | le process est tué | le process survit |
| sortie dans un fichier | le process se bloque | le process continue d'écrire |

Les deux séparément ne donnent rien. Ensemble :

1. Le CLI écrit son flux dans `data/turns/<conv>.jsonl` au lieu d'un tuyau — un fichier ne se
   ferme pas quand son lecteur meurt.
2. agentHub **suit ce fichier** au lieu de lire un tuyau. Un seul chemin de code, que le turn
   soit démarré à l'instant ou repris au démarrage.
3. Un enregistrement `data/inflight.json` retient `{convId, pid, fichier, position}`. Au
   démarrage, pour chaque turn en vol : si le PID vit, on reprend la lecture à la position
   enregistrée ; s'il est mort, on lit la fin du fichier et on conclut le turn avec ce qui y
   est réellement.

Le point qui rend la reprise sûre : la position lue est persistée, donc rien n'est traité
deux fois, et rien n'est perdu entre le dernier relevé et l'arrêt.

## Ce qui reste à décider

- **Le nom du fichier.** Un fichier par conversation se réécrit à chaque turn, ce qui suffit —
  le journal des items, lui, garde l'historique. Un fichier par turn serait plus traçable mais
  demande une purge.
- **La détection de fin sans handle.** Au démarrage on n'a pas d'objet enfant : c'est
  `/proc/<pid>` qui dit si le turn vit encore, comme le fait déjà `descendants()` dans
  `lib/runner.js`.
- **Le turn qui n'a produit aucun `result`.** Un CLI tué avant sa fin ne l'écrit pas. Il faut
  conclure en erreur, mais après avoir traité tout ce qu'il avait déjà écrit.
