# docs/solutions

Ce qu'on a appris sur ce projet, et qui ne se déduit pas du code.

Un fichier par apprentissage. Du markdown, dans le dépôt, lisible par Claude Code, Codex et
Grok sans service extérieur : c'est là que le contexte survit entre deux sessions, et entre
deux modèles.

## Quoi écrire ici

- **Un bug et sa cause réelle.** Pas « corrigé le bug d'affichage », mais pourquoi il
  arrivait. Le symptôme se retrouve dans git ; la cause, non
- **Une décision et ce qu'on a écarté.** Ce qui empêche de rouvrir le débat dans six mois,
  ou de « corriger » un choix délibéré
- **Un piège de l'environnement.** Une version qui se comporte autrement que sa
  documentation, un ordre d'opérations qui compte, une commande qui échoue en silence
- **Une mesure.** Un chiffre relevé sur cette machine vaut mieux qu'une estimation

## Quoi ne pas écrire ici

Ce que le code dit déjà, ce que `git log` raconte, les conventions du projet — elles vont
dans `AGENTS.md` — et le compte rendu d'une tâche terminée. Si l'information ne sert que
pendant la tâche en cours, elle n'a pas sa place ici.

## Forme

Un fichier par sujet, nommé en clair : `pm2-ne-lit-pas-bashrc.md` plutôt que `note-3.md`.
Un en-tête minimal pour que ce soit retrouvable :

```markdown
---
titre: PM2 ne lit pas le .bashrc
type: piege
date: 2026-07-31
---

Le symptôme, la cause, et ce qu'il faut faire à la place.
```

`type` sert à trier : `bug`, `decision`, `piege`, `mesure`, `convention`.

## Pourquoi ici et pas dans un service de mémoire

Parce que c'est versionné avec le code qu'il décrit, que ça ne sort pas du serveur, que ça
ne dépend d'aucune authentification qui expire, et que les trois CLIs le lisent déjà. Une
note qui devient fausse se corrige dans le même commit que le code qui l'a rendue fausse.

## Retours d'expérience à lire en premier

- [Les conversations longues bloquaient l'ouverture sur mobile](les-conversations-longues-bloquaient-le-mobile.md) : pagination, index dérivé et chargement différé des résultats.
- [Le fil entier était réécrit à chaque message](le-fil-entier-etait-reecrit-a-chaque-message.md) : passage à un journal JSONL en ajout.
- [Reprendre un turn après redémarrage](reprendre-un-turn-apres-redemarrage.md) : flux fichier, curseur et processus survivant.
- [La consommation comptait des cumuls et perdait des turns](la-consommation-comptait-des-cumuls-et-perdait-des-turns.md) : normalisation des métriques hétérogènes.
