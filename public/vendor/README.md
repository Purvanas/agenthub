# Bibliothèques embarquées

Ce dossier contient du code qui n'est pas de nous, servi tel quel au navigateur.

## `mermaid.min.js` — 11.16.1

Le moteur de rendu des schémas du tiroir « Plans et schémas » : MCD (`erDiagram`), diagrammes de
séquence, cas d'usage, classes, états. Voir `public/plans.js`.

**Pourquoi le fichier est ici plutôt qu'appelé sur un CDN.** Trois raisons, dans l'ordre où elles
comptent :

1. `index.html` ne charge aucune URL externe, et ce n'est pas un hasard : agentHub est joint par
   des chemins dont certains n'ont pas Internet. Un schéma qui ne s'affiche pas parce qu'un CDN
   est injoignable serait une panne incompréhensible depuis l'interface.
2. **Ce n'est pas une dépendance npm**, et ça ne peut pas l'être. `node_modules/` est hors du
   dépôt, et le déploiement est un `git push` — sans étape `npm install`. Une dépendance déclarée
   dans `package.json` ne serait donc pas là après un déploiement.
3. La version est **figée**. Un `@11` sur un CDN suit les publications mineures : un jour où
   mermaid change le rendu d'un `erDiagram`, les schémas du projet changeraient sans que rien
   n'ait été touché ici.

**Ce que ça coûte, et pourquoi c'est acceptable.** 3,5 Mo dans le dépôt, une fois. Le fichier
n'est **pas** chargé par `index.html` : `plans.js` va le chercher à la première ouverture du
tiroir, donc une session qui ne regarde aucun schéma ne le télécharge jamais.

### Le remettre à jour

```sh
curl -fsS -o public/vendor/mermaid.min.js \
  "https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js"
```

Vérifier ensuite que le fichier finit bien par une affectation à `globalThis["mermaid"]` : c'est
cette forme — le build UMD — que `plans.js` attend, et mermaid publie aussi un build ESM qui ne
définit aucun global et resterait silencieusement inerte.

```sh
tail -c 80 public/vendor/mermaid.min.js
```

Puis ouvrir le tiroir sur un projet qui a des schémas, et regarder qu'ils se dessinent — les
tests ne couvrent pas le rendu, qui demande un navigateur.

Version posée le 12/08/2026, empreinte SHA-256 :
`18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`
