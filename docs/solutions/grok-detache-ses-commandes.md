---
titre: Grok détache les commandes de ses outils, l'interruption ne les atteint pas
type: piege
date: 2026-07-31
---

## Symptôme

Un turn Grok interrompu — bouton ■ ou durée maximale d'un déclencheur — est bien arrêté : le
CLI meurt, la conversation passe en « interrompu ». Mais la commande que l'agent avait lancée
continue. Mesuré avec `sleep 300` : coupé à une minute côté agentHub, le `sleep` tournait
encore quatre minutes plus tard.

## Cause

Grok double-forke les commandes de ses outils. Vérifié pendant qu'un turn tournait :

```
grok pid: 3587946
enfants directs:            (vide)
sid grok: 3587946  pgid: 3587946
sleep 3587992 -> ppid 3587988 sid 3587988 pgid 3587988
```

Le process Grok n'a **aucun enfant direct**, et le shell qui porte la commande a sa propre
session et son propre groupe, rattaché à init. Il n'existe donc aucun lien exploitable :
ni parenté, ni session, ni groupe de process.

Conséquence sur les trois signaux qu'on pourrait envoyer :

- `kill -TERM -<pid>` (groupe) : n'atteint pas la commande, elle a changé de groupe
- parcours de `/proc/<pid>/task/<pid>/children` : ne la voit pas, elle n'est plus descendante
- correspondance par session : inutile, elle a la sienne

## Ce qui a été fait

`killTree` dans `lib/runner.js` relève les descendants dans `/proc` **avant** de tuer, puis
les signale un par un. Ça ne règle pas le cas Grok, mais ça règle Claude, qui garde ses
sous-process comme enfants directs — vérifié, `enfants directs: [3588414]`.

La limite Grok est documentée dans `README.md` et dans les risques du plan.

## Ce qu'il faudrait pour fermer le cas

Lancer chaque turn dans son propre cgroup et tuer le cgroup. Ça change la façon de lancer
*tous* les turns, pour un cas qui ne concerne qu'un fournisseur, et l'application tourne sans
root. Écarté sciemment. À rouvrir si des commandes orphelines s'accumulent réellement.
