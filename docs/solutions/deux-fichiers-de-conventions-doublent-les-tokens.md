---
titre: Grok lit AGENTS.md et CLAUDE.md, et charge les deux s'ils existent
type: mesure
date: 2026-07-31
---

## Ce qui a été mesuré

Trois dossiers de test, `grok inspect` dans chacun :

| Contenu du dossier | Ce que Grok charge |
|---|---|
| `CLAUDE.md` seul | 1 fichier : `CLAUDE.md` |
| `AGENTS.md` seul | 1 fichier : `AGENTS.md` |
| les deux, fichiers réels | **2 fichiers** |
| `AGENTS.md` → lien vers `CLAUDE.md` | 1 fichier |

## Conséquences

**Grok lit les deux noms.** Inutile de dupliquer le contenu pour qu'il le voie.

**Deux vrais fichiers coûtent deux fois les tokens.** Sur un projet dont les conventions
pèsent 600 tokens, avoir `AGENTS.md` et `CLAUDE.md` en fichiers distincts fait payer 1200
tokens à chaque turn, pour la même information.

**Le lien symbolique est la bonne réponse**, pas la copie : Grok dédoublonne par chemin
résolu. Un seul fichier de conventions, visible sous les deux noms — Claude Code cherche
`CLAUDE.md`, Codex cherche `AGENTS.md`.

## Piège de mise en œuvre

Git Bash sous Windows ne crée pas de lien symbolique : `ln -s` y produit une copie. Un dépôt
édité depuis Windows finit donc avec deux fichiers réels sans qu'on le voie. Ici, le dépôt ne
porte qu'`AGENTS.md`, et le lien `CLAUDE.md` est créé côté serveur — le déploiement par `scp`
fichier par fichier ne l'écrase pas.
