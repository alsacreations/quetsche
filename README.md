# Quetsche

Outil ultra-simple de compression et (re)dimensionnement d'images entièrement côté navigateur. Aucun fichier n'est envoyé sur un serveur : tout se fait localement via les APIs Web (File, Canvas, Web Worker).

## Objectifs

- Importer une image JPEG ou PNG
- (Optionnel) Redimensionner selon un préréglage (Original / 1400px)
- Recompresser le fichier (qualité fixe 75%)
- Produire une version compressée + une version WebP
- Afficher des métriques (gain %, octets économisés, bits/pixel, estimation CO₂)
- Proposer des liens de téléchargement explicites (section + lien direct dans le figcaption compressé)
- Accessibilité et design token‑driven

## Caractéristiques principales

- 100% local (privacy by design)
- Interface minimale & responsive (layouts utilitaires data-layout)
- Résultats instantanés (dès sélection / drop)
- Couche de styles structurée par cascade layers: `reset`, `theme`, `tokens`, `layouts`, `styles`
- Design tokens (couleurs, espacements, typo, états) -> pas de valeurs magiques dans les styles applicatifs
- Web Worker pour éviter de bloquer le thread principal lors du traitement

## Architecture des fichiers

```text
photo-mini/
  index.html               # Page unique de l'application
  assets/
    css/
      app.css              # Point d'entrée CSS (imports avec @layer)
      reset.css            # Reset typographique / normalisation
      theme.css            # Valeurs primitives (couleurs, spacing, font sizes…)
      theme-tokens.css     # Tokens sémantiques (layer, accent, success, gaps…)
      layouts.css          # Layouts utilitaires (stack, duo, autogrid, switcher…)
      styles.css           # Styles applicatifs (aucune valeur hors tokens/primitives)
    js/
      app.js               # Logique principale UI + worker messaging
      worker.js            # Traitement image (decode -> resize -> encode)
```

## Flux de traitement

1. L'utilisateur sélectionne / dépose un fichier
2. `app.js` lit le blob, crée un objet Image pour récupérer dimensions
3. Calcul éventuel des dimensions cibles selon le radio sélectionné
4. Le buffer est posté au `worker.js`
5. Le worker :
   - Décode via `createImageBitmap`
   - Redimensionne via `OffscreenCanvas` si besoin
   - Encode la version compressée (même mime) + WebP (via `canvas.toBlob`)
6. Le main thread reçoit les blobs, met à jour les aperçus, calcule métriques, insère liens

## Redimensionnement

Préréglages (radios) :

- Original (aucun redimensionnement)
- Web 1400 (plus grand côté ramené à 1400px)

Ratio préservé : seul le plus grand côté est contraint.

## Compression

- Qualité fixe `0.75` (native encoder canvas)
- Pas (encore) de codecs avancés type MozJPEG / OxiPNG / AVIF : intégration future (WASM)

## Accessibilité (a11y)

- Statut dynamique aria-live pour l'état de traitement (`role="status"`)
- Résultats annoncés (aria-busy pendant le travail)
- Focus management sur le titre des résultats après import
- Lien de téléchargement dans le `figcaption` + section dédiée structurée (`section.download-group`)
- Groupement radio accessible via `role="radiogroup"` + libellé `<p id="resizeTitle">`
- Élément input file masqué de façon accessible (visually hidden technique) et action via label stylisé

## Layouts utilitaires

Basés sur `layouts.css` via attributs `data-layout`:

- `data-layout="duo" data-model="2-1"` pour la zone d'import + options
- `data-layout="switcher"` / `autogrid` pour la grille des comparaisons (selon configuration courante)

Aucune media query dans `styles.css` : adaptativité déléguée aux patterns utilitaires + tokens fluides (`clamp`).

## Design tokens

- Couleurs thématisées : `--layer-*`, `--accent`, `--on-surface`, `--success`, `--error`…
- Typographie responsive via `clamp()` (ex: `--text-m`, `--text-l`, `--text-2xl`)
- Espacements fluides : `--gap-s/m/l` et `--spacing-*`
- États : focus ring (`--focus-ring-color`, `--focus-ring-width`)

`styles.css` n'emploie que des variables définies dans `theme.css` (primitives) ou `theme-tokens.css` (sémantique).

## Sécurité & confidentialité

- Aucune requête réseau pour les images
- Les blobs générés sont en mémoire locale (URL.createObjectURL)
- Rien n'est stocké ni persisté

## Limitations actuelles

- Encodage natif : la qualité peut être inférieure à des codecs spécialisés
- Pas d'aperçu différentiel visuel ou slider de comparaison
- Pas d'AVIF (retiré pour simplification)
- Pas de paramètre de qualité ajustable

## Pistes d'amélioration

- Intégration WASM (MozJPEG, OxiPNG, Squoosh codecs) avec fallback natif
- Batch multi-fichiers
- Historique des traitements / drag multi
- Réglage qualité avancé + estimation temps/cpu
- Analyse plus fine CO₂ (inclure dimensions / network model configurable)
- Mode offline PWA (manifest + service worker)
- Tests unitaires (compression pipeline abstraitée)

## Utilisation

Ouvrir simplement `index.html` dans un navigateur moderne (Chrome, Firefox, Edge, Safari récents). Aucune étape de build nécessaire.

1. Cliquer sur "Choisir une image" ou glisser-déposer un fichier
2. Choisir un préréglage de taille (facultatif)
3. Attendre la fin du traitement (statut mis à jour)
4. Télécharger la version compressée et/ou WebP (liens en section + lien direct dans le figcaption compressé)

## Compatibilité navigateur

Fonctionne sur navigateurs supportant :

- `createImageBitmap`
- `Web Worker` module
- `OffscreenCanvas` (amélioration de performance; fallback possible à ajouter pour anciens navigateurs)

## Style & Conventions

- Aucune media query dans `styles.css`
- Responsive assuré par tokens fluides et layouts utilitaires
- Pas de valeurs brutes (hex, rem, px) hors déclarations de tokens / primitives
- Nommage BEM minimal : classes simples (`.field-group`, `.dropzone`, `.inline-download`)

## Accessibilité à vérifier (checklist abrégée)

- Navigation clavier complète (OK)
- Focus visible (accent system color) (OK)
- Annonces statut (aria-live) (OK)
- Groupes de choix (radiogroup) (OK)
- Contrastes (à auditer avec un outil automatique pour certaines combinaisons accent/fond)

## Performances

Traitement unique en mémoire. Pas de dépendances externes, pas de bundler. Taille CSS minime (layers + tokens).

## Licence

(Spécifier une licence : MIT ? CC0 ? À définir.)

## Crédit

Prototype interne – structure CSS & tokens inspirés des conventions Alsacréations.

---

Pour toute nouvelle fonctionnalité, garder : simplicité, tokens only, aucune valeur arbitraire dans `styles.css`, accessibilité prioritaire.
