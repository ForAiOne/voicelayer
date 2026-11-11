# VoiceLayer V1 — studio vocal multipiste local

Application web locale (HTML/CSS/JS, sans build) pour enregistrer plusieurs prises
vocales superposées, les écouter ensemble, les mixer et exporter un WAV à importer
dans Suno. Cible finale : Android en PWA. Pour l'instant : ton PC Windows + Chrome.

## Version en ligne (recommandée sur PC et Android)

**https://foraione.github.io/voicelayer/**

Une adresse HTTPS unique : pas de Live Server, pas de port, pas de risque d'ouvrir
le mauvais dossier. Le micro et l'AudioWorklet y fonctionnent, y compris depuis un
téléphone Android. Attention : le stockage (IndexedDB) est lié à l'adresse, donc
`https://foraione.github.io/voicelayer/` et `http://127.0.0.1:5500/` sont **deux
projets séparés** — ne mélange pas les deux.

> **Ne jamais ouvrir `index.html` par double-clic** (`file://`) : Chrome y refuse le
> micro et l'AudioWorklet. Il faut une adresse http(s) : l'URL GitHub, ou Live Server.

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

## Retour casque (s'entendre en direct)

Bouton **🎧 Activer le retour casque** dans le panneau Microphone — jamais actif au
départ, et jamais mémorisé. Le micro est renvoyé vers la sortie audio, branché **en
parallèle** du chemin d'enregistrement : ce que tu entends ne change donc rien à ce qui
est capté. Sur téléphone, le message d'avertissement parle d'écouteurs : en haut-parleur,
le larsen est immédiat.

- **Casque obligatoire.** Avec des enceintes, le micro reprend le son des haut-parleurs
  et produit un larsen immédiat — une confirmation le rappelle avant d'activer.
- Le retour passe par le logiciel : il est décalé de quelques dizaines de ms par rapport
  à ta voix réelle. C'est normal, et ça ne fausse pas l'enregistrement.
- **Volume du retour** règle le niveau du casque seulement.
- Le réglage n'est pas mémorisé : à chaque ouverture, le retour est coupé. C'est
  volontaire — se retrouver avec un retour actif sur des enceintes produirait un larsen
  dès la première prise.
- Le micro se ferme entre deux prises, donc le retour s'arrête aussi. Il reprend tout
  seul à la prise suivante.

## Pause, position et prise en plein milieu

Le bouton **▶ Tout écouter** devient **⏸ Pause** pendant la lecture : il fige la position
et le bouton **⏮ Début** la ramène à zéro. Sous les boutons, une ligne indique
`position 00:45 · durée 03:12` et, quand ce n'est pas zéro, `prochaine prise à 00:45`.

Le **curseur reste planté** à l'endroit de la pause (bleu, avec un repère en haut) : on
voit toujours où la suite démarrera. Pendant la lecture il est orange et il avance ; après
une prise il reste à l'endroit où elle s'est terminée, donc là où repartira la suivante.

**Enregistrer en plein milieu** se fait de deux façons, sans réglage préalable :

- **Pause, puis « Enregistrer une piste »** : la nouvelle prise démarre exactement à la
  position de pause, et l'accompagnement reprend à cet endroit (pas depuis le début).
- **« Enregistrer une piste » pendant la lecture** : l'instant courant est figé, la prise
  démarre là où tu en es.

Chaque piste retient sa **position de départ** (`départ 00:45` sur sa ligne) :

- sa forme d'onde est dessinée à cet endroit de la timeline, pas collée à gauche ;
- la lecture et l'export la placent au bon moment — le mix reste synchronisé ;
- un projet peut ainsi dépasser la durée de chaque piste prise séparément.

## Formes d'onde et synchronisation

Chaque piste affiche sa forme d'onde sous son nom, avec une règle de temps au-dessus de
la liste et un curseur orange qui avance pendant l'écoute. Deux points à retenir :

- **L'échelle de temps est commune à toutes les pistes** (`0` → durée de la plus longue).
  Une piste de 3 s n'occupe donc que la moitié de la largeur si le projet dure 6 s : on
  voit immédiatement où chaque voix démarre, et deux pistes alignées se superposent
  verticalement.
- **L'amplitude est normalisée piste par piste** : une voix douce reste lisible au lieu
  d'être écrasée par une voix forte. La hauteur ne compare donc pas les volumes — les
  curseurs **Volume** s'en chargent.

Pour se synchroniser sur une prise existante : écoute-la, repère la position du curseur
là où la voix entre, puis place ton entrée au même endroit sur la règle. Après la prise,
les boutons **◀ 10 ms / 10 ms ▶** ajustent finement.

Une piste muette garde sa forme d'onde, en gris : elle sert de repère même quand on ne
veut pas l'entendre. Une piste silencieuse s'affiche en rouge.

## Le témoin de silence

Après chaque prise, l'application mesure le niveau réellement capté et l'annonce
(« niveau max 62 % »). Si le micro n'a rien capté, la piste est enregistrée quand
même — rien n'est perdu — mais elle porte la mention **⚠ SILENCIEUSE** et la carte
passe en rouge. C'est ce qui distingue « le micro n'a rien pris » de « le son ne
sort pas » : dans le second cas, la piste affiche un niveau normal.

Pendant la prise, deux niveaux sont affichés sous la jauge :

- **niveau micro (max)** : ce que le navigateur reçoit du périphérique ;
- **niveau enregistré (max)** : ce que l'enregistreur PCM reçoit réellement.

Si le premier monte et que le second reste à 0 %, c'est l'application qui est en
cause, pas le matériel — et le message de fin de prise le dit explicitement. La ligne
**Micro réellement ouvert** indique le nom exact du périphérique utilisé, ce qui
repère immédiatement une mauvaise sélection.

## Le décalage : ce qui reste à régler

Le logiciel ne décale plus rien : la prise est calée en échantillons sur le départ de
l'accompagnement. Ce qui reste, c'est la **latence du matériel** (le temps que le son
met à sortir des haut-parleurs et celui que met le micro à le convertir). C'est un
nombre constant pour un micro donné.

Deux façons de le régler :

- **Avant la prise** : champ **Décalage matériel (ms)** dans le panneau Microphone.
  Il est mémorisé pour le micro sélectionné. Positif avance la prise.
- **Après la prise** : boutons **◀ 10 ms** / **10 ms ▶** sur la piste, qui recalent
  l'enregistrement déjà fait, par pas de 10 ms, sans ré-enregistrer. Le calage cumulé
  s'affiche en permanence sur la piste (`calage +20 ms`) et le bouton **↺ 0** l'annule.
  Il est conservé dans la sauvegarde du projet.

Convention de signe, la même partout : **positif = la piste est avancée** (elle démarre
plus tôt, parce que la voix était arrivée en retard), **négatif = retardée**. Le nombre
trouvé avec les boutons se recopie donc tel quel dans le champ **Décalage matériel (ms)**
pour ne plus avoir à le refaire sur les prises suivantes.

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

Le dossier `tests/` contient trois scripts Playwright qui pilotent un vrai Chrome
avec un faux microphone (`npm install`, puis `python3 -m http.server 8099` dans le
dossier de l'app, puis `node tests/e2e.js`) :

- `e2e.js` — 21 contrôles : démarrage du moteur, jauge micro, annulation du décompte,
  prise réelle, **alignement de la durée**, niveau capté, export stéréo 16 bits, mute
  général sans effet sur l'export, avertissement de mute, mute de piste respecté,
  recalage +10 ms, sauvegarde JSON.
- `migration.js` — 7 contrôles : une piste WebM de la V0.2 déposée en base est bien
  convertie en WAV au chargement, sans perte, et reste audible dans l'export.
- `silence.js` — 5 contrôles : une piste sans signal est mesurée, marquée
  **⚠ SILENCIEUSE** et signalée visuellement.

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
