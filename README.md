# VoiceLayer V1 — studio vocal multipiste local

Application web locale (HTML/CSS/JS, sans build) pour enregistrer plusieurs prises
vocales superposées, les écouter ensemble, les mixer et exporter un WAV à importer
dans Suno. Cible finale : Android en PWA. Pour l'instant : ton PC Windows + Chrome.

## Lancer

1. Ouvrir le dossier dans VS Code.
2. Ouvrir `index.html`, clic droit → **Open with Live Server** (ou bouton **Go Live**).
3. Travailler sur `http://127.0.0.1:5500/index.html`.

> **Ne pas** ouvrir `index.html` par double-clic depuis l'explorateur : le navigateur
> refuse alors micro et AudioWorklet (il faut `http://127.0.0.1` ou HTTPS).
> L'extension Live Server n'a plus besoin d'être configurée autrement.

## Ce qui a changé depuis la V0.2

| Sujet | V0.2 | V1 |
|---|---|---|
| Capture | `MediaRecorder` → WebM/Opus | `AudioWorklet` → PCM 16 bits |
| Horloge de la prise | opaque, indépendante de la lecture | la même que l'`AudioContext` de lecture |
| Décalage au démarrage | présent, non réglé | supprimé au niveau logiciel, reste la latence matérielle (un nombre, réglable) |
| Format stocké | WebM à décoder à chaque fois | WAV, téléchargeable tel quel |
| Sortie d'une piste | impossible | bouton ⤓ sur chaque piste |
| Sauvegarde du projet | inexistante | bouton **Sauvegarder le projet** (JSON) + **Charger un projet** |
| Service Worker | présent | **supprimé** (et l'ancien est désinscrit au chargement) |
| Migration des anciennes prises | — | automatique, en WAV, sans suppression |

Le mute général ne coupe jamais le micro ni l'enregistrement, et il n'apparaît pas
dans l'export (seul le mute d'une piste rend cette piste silencieuse).

## Enregistrer une piste

1. Choisir le micro, cliquer **Tester le microphone**, vérifier que la jauge réagit.
2. **Enregistrer une piste** → décompte de 3 secondes → la prise commence.
3. Les pistes existantes sont jouées en accompagnement, avec leur volume et leur mute.
4. **Arrêter** → la piste apparaît dans la liste.

Un casque est fortement recommandé : sans lui, le micro reprend les pistes déjà
enregistrées et la superposition devient inaudible.

## Importer un accompagnement

**Importer un audio** accepte un WAV, MP3, M4A ou WebM (par exemple un instrumental
Suno). Le fichier est ramené à la fréquence du projet et devient une piste comme une
autre : tu peux chanter dessus, la mettre en mute, etc.

## Le témoin de silence

Après chaque prise, l'application mesure le niveau réellement capté et l'annonce
(« niveau max 62 % »). Si le micro n'a rien capté, la piste est enregistrée quand
même — rien n'est perdu — mais elle porte la mention **⚠ SILENCIEUSE** et la carte
passe en rouge. C'est ce qui distingue « le micro n'a rien pris » de « le son ne
sort pas » : dans le second cas, la piste affiche un niveau normal.

## Le décalage : ce qui reste à régler

Le logiciel ne décale plus rien : la prise est calée en échantillons sur le départ de
l'accompagnement. Ce qui reste, c'est la **latence du matériel** (le temps que le son
met à sortir des haut-parleurs et celui que met le micro à le convertir). C'est un
nombre constant pour un micro donné.

Deux façons de le régler :

- **Avant la prise** : champ **Décalage matériel (ms)** dans le panneau Microphone.
  Il est mémorisé pour le micro sélectionné. Positif avance la prise.
- **Après la prise** : boutons **◀ 10 ms** / **10 ms ▶** sur la piste, qui recalent
  l'enregistrement déjà fait, par pas de 10 ms, sans ré-enregistrer.

Méthode de calibration : enregistre en chantant par-dessus une piste existante, écoute
le résultat, puis recale la nouvelle piste jusqu'à ce que les deux attaques coïncident.

## Sauvegarde : à faire systématiquement

Les prises vivent dans IndexedDB, donc dans **ce navigateur, sur cet appareil**. Un
« nettoyage » de Chrome les détruit.

- **Sauvegarder le projet** → un fichier `Nom_voicelayer.json` contenant toutes les
  pistes (audio inclus, en base64). Range-le ailleurs que sur le PC.
- **⤓** sur une piste → le WAV de cette piste seule.
- **Charger un projet** → restaure un fichier de sauvegarde.

> Un projet de 10 pistes de 5 minutes pèse lourd (plusieurs centaines de Mo en JSON).
> Dans ce cas, préfère le téléchargement piste par piste.

## Vérifications automatiques

Le dossier `../test/` contient deux scripts Playwright qui pilotent un vrai Chrome
avec un faux microphone :

- `e2e.js` — 17 contrôles : démarrage du moteur, jauge micro, annulation du décompte,
  prise réelle, **alignement de la durée**, export stéréo 16 bits, mute général sans
  effet sur l'export, mute de piste respecté, recalage +10 ms, sauvegarde JSON.
- `migration.js` — 7 contrôles : une piste WebM de la V0.2 déposée en base est bien
  convertie en WAV au chargement, sans perte, et reste audible dans l'export.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | interface |
| `styles.css` | présentation |
| `app.js` | logique, stockage, export |
| `worklet-recorder.js` | capture PCM dans l'horloge de l'AudioContext |
| `manifest.webmanifest`, `icon.svg` | préparation PWA (Android, plus tard) |

Il n'y a **pas** de `sw.js` : le Service Worker de la V0.2 a été retiré. S'il en reste
un d'enregistré dans Chrome, la V1 le désinscrit au chargement.
