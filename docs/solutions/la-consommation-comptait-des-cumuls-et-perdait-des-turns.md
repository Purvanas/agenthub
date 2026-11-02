---
titre: La consommation comptait des cumuls et perdait des turns
type: bug
date: 2026-08-03
---

# Deux erreurs de sens inverse dans le journal de consommation

## Le symptôme

« La consommation est freezée » — plusieurs conversations dans la matinée, le nombre de tokens
et le coût n'avaient pas bougé.

Le journal, lui, s'écrivait : `data/usage.jsonl` avait 29 lignes ce jour-là, la dernière quatre
minutes avant la capture d'écran. Ce n'était pas un gel, c'était un trou — et un trou qui
avalait précisément les turns les plus chers.

## Cause 1 : ce qui n'est jamais compté

`usage.record` n'était appelé qu'à la réception de l'événement `result` du CLI. Un turn tué
avant sa fin ne l'émet jamais : **ses tokens n'étaient journalisés nulle part.**

Cinq turns dans ce cas ce matin-là, dont trois dans la même conversation, entre 11 h 20 et
12 h 29. Ils étaient longs et ils étaient chers : les deux turns voisins, qui se sont eux
terminés normalement, coûtaient 2,96 $ et 2,37 $ à eux seuls.

La cause de la coupure n'était pas un accident, c'était la procédure normale : la matinée
avait été passée à modifier agentHub, donc à le redémarrer. Voir
`reprendre-un-turn-apres-redemarrage.md` — la reprise d'un turn a été déployée le même jour,
mais elle ne rattrape pas la consommation d'un turn dont le CLI est mort.

Pendant ce temps, les lignes qui *arrivaient* étaient celles de petits turns Haiku à 0,03 $.
D'où l'impression d'un compteur figé : il avançait, mais de trois centimes à la fois.

### Ce qui rend la reconstitution possible, et le piège

Claude publie l'usage de **chaque appel API** sur ses événements `assistant`, modèle compris.
Le flux du turn étant maintenant un fichier sur disque, il suffit de le relire et d'additionner.

Le piège, vérifié sur un vrai flux : le CLI émet un événement `assistant` **par bloc de
contenu**, tous porteurs du même `message.id` et du **même relevé**. Une réflexion suivie de
deux appels d'outils fait trois événements pour un seul appel API. Les sommer aurait triplé la
facture au lieu de la retrouver. La déduplication se fait sur `message.id`.

Deuxième piège, découvert en testant : interrompre un turn depuis l'interface produit un
`result` **en erreur, mais avec son relevé**. Déclencher la reconstitution sur « pas de
résultat » ne couvrait donc pas le cas de l'arrêt — et déclencher sur « pas de relevé » couvre
les deux. C'est le relevé qui décide, pas le résultat.

## Cause 2 : ce qui était compté plusieurs fois

Le relevé de Codex ne se lit pas comme celui de Claude, et les deux malentendus se
multipliaient : **34,6 M de tokens journalisés pour 10,6 M consommés, 96 $ affichés pour 8 $.**

### 2a. Ce n'est pas la consommation du turn, c'est le cumul de la session

Ce total est lu dans le fichier de session, donc il survit à ses process et grossit d'un turn au
suivant. Chaque turn journalisait le total complet. Relevé sur une conversation du jour, tokens
d'entrée par turn successif :

```
899 280 → 1 028 219 → 1 093 571 → 1 159 039 → 1 746 792 → 1 824 545
```

Six lignes qui, additionnées, comptent six fois le même contexte.

### 2b. L'entrée annoncée inclut le cache relu

Comme le `prompt_tokens` d'OpenAI inclut ses `cached_tokens`. Additionner les deux champs
facturait la part en cache **aux deux tarifs à la fois** — plein tarif d'entrée, puis tarif de
cache — et la comptait deux fois dans les tokens. Sur une longue session, où 90 % de l'entrée
annoncée vient du cache, c'est le terme dominant : à lui seul, il gonflait le coût d'un facteur
proche de dix.

Celui-là a survécu à une correction *antérieure* qui portait sur le même champ. Le 01/08, on
avait ajouté `cachedInput` à la table de prix parce que le cache relu était facturé au plein
tarif d'entrée. La correction était juste et la lecture des champs restait fausse : on a cessé
de surfacturer le cache tout en continuant à facturer l'entrée qui le contient déjà.

Pourquoi c'est resté invisible : rien, dans une ligne, ne distingue « 800 d'entrée **et** 100 de
cache » de « 800 d'entrée **dont** 100 relus ». Aucune incohérence à trouver, aucune exception à
lever — les deux lectures produisent un journal parfaitement bien formé.

Ce qui l'a révélé est un rapport de vraisemblance, pas une inspection. Trois indices :

- sur 29 lignes, le cache lu ne dépasse **jamais** l'entrée — la signature d'un sous-ensemble ;
- sa part monte régulièrement jusqu'à 97 % à mesure que la session grossit ;
- deux turns minuscules lancés exprès — « dis bonjour », puis « redis bonjour » — où le second
  annonce 15 102 tokens d'entrée dont 14 080 en cache. **Redire bonjour n'envoie pas 15 000
  tokens neufs alors que tout le contexte est déjà en cache.** C'est celui-là qui tranche.

Un quatrième indice, indirect mais parlant : Codex ressortait à 2,78 $ par million de tokens,
pour un modèle moins cher que Claude, qui se chiffrait lui-même à 0,92 $/M. Après correction,
0,79 $/M. Quand un provider dérive d'un facteur trois par rapport aux autres sur la même unité,
l'écart *est* le symptôme.

### Ce que la correction donne

Une ligne Codex porte maintenant des champs **disjoints**, la même convention que Claude :
l'entrée est ce qui a été envoyé neuf, et le cumul brut est conservé à part dans `codexTotals`
pour que le turn suivant sache contre quoi se soustraire. Un cumul en baisse veut dire qu'on
regarde une autre session : son total est alors le sien.

Effet de bord heureux : un turn Codex coupé n'a rien à reconstituer. Sa consommation est dans
le cumul, donc elle est rattrapée par le delta du turn suivant.

## Ce qui a servi de preuve

La table de prix Claude n'existait pas — elle était inutile tant que seul un turn complet était
journalisé, puisque le CLI le chiffre lui-même. Il a fallu l'écrire pour les turns coupés, et
donc pouvoir affirmer qu'elle est juste.

Elle a été **vérifiée à rebours** sur quatre turns réels du journal (opus-5, opus-5[1m],
sonnet-5, haiku-4.5) : elle reproduit au centième de cent le `costUSD` que Claude Code avait
lui-même calculé. C'est ce qui a révélé que l'écriture de cache a son propre tarif, plus
**cher** que l'entrée — deux fois pour un cache d'une heure, une fois et quart pour cinq
minutes. La compter au tarif d'entrée, ce que faisait déjà la table pour Codex, sous-estimait
de moitié un turn qui écrit beaucoup de contexte.

Le partage entre les deux durées ne se lit que sur les événements intermédiaires
(`cache_creation.ephemeral_1h_input_tokens`) : le relevé final du turn ne le donne pas.

## La réparation de l'historique

`data/usage.jsonl` a été réécrit le 03/08/2026 par `scripts/reparer-cumuls-codex.js`, sur
décision explicite — c'est le seul endroit de l'application où `data/` est réécrit. Trois
propriétés en font un outil et pas un coup de force :

- **Idempotent.** Le cumul de départ est relu dans `codexTotals` quand la ligne le porte, sinon
  dans ses propres champs — c'est exactement ce qu'ils contenaient à l'époque. Une ligne déjà
  convertie redonne le même delta ; relancer ne dérive pas. Vérifié en relançant.
- **Une seule règle.** Le script n'a pas sa copie de la logique : il appelle `codexTokens` et
  `priceFromTable` de `lib/usage.js`, celles-là mêmes qui écrivent les nouvelles lignes.
- **Sûr face aux écritures concurrentes.** L'application tournait, et un turn Codex était en
  cours. Le journal étant append-only, ce qui est ajouté entre la lecture et l'écriture est
  recopié à la fin, et le remplacement est atomique. Le script refuse d'écrire si le fichier
  n'est plus un sur-ensemble de ce qu'il a lu.

Sauvegarde conservée à côté, horodatée : `usage.jsonl.avant-deltas-<date>`.

## Ce qui reste hors d'atteinte

Un turn tué **pendant** son premier message. L'usage n'existe qu'une fois l'appel API terminé ;
avant, il n'y a rien à relire.
