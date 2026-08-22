# Buen Camino, Olga 🐚

> **Progetto personale / side project.** Questa app **non fa parte dei progetti Bike Adventure Series**: è un companion personale per il Cammino di Santiago di Olga (Cammino Francese + Epilogo a Fisterra, settembre–ottobre 2026).
> **Personal side project**, unrelated to the Bike Adventure Series business projects.

Web app (PWA) che accompagna una pellegrina alla prima esperienza di cammino, da Saint-Jean-Pied-de-Port a Santiago e Fisterra (~850 km). Tre gesti al giorno — **Parto**, **Dove dormo stasera?**, **Fine tappa** — e l'app restituisce meteo proiettato sulla giornata, nastro «cosa c'è davanti», consiglio onesto su dove fermarsi, proiezioni d'arrivo e diario.

Cugina delle app evento BAS ([`tg-guida`](https://github.com/advlabbik/tg-guida) → [`tuscany-trail-app`](https://github.com/advlabbik/tuscany-trail-app) → [`northcape4000-app`](https://github.com/advlabbik/northcape4000-app)) — stessa filosofia (vanilla JS, zero build, Pages, offline-first) ma codice autonomo: qui il percorso è uno solo, lungo 33+ giorni, e la logica ruota su posizione e giorni, non su un evento con una data.

Vanilla JS, nessun build step, nessuna dipendenza npm. Leaflet 1.9.4 self-hosted in `assets/vendor/` (niente CDN).

## Come si apre

Serve un server statico qualsiasi (HTTPS/localhost per geolocalizzazione e service worker):

```bash
python -m http.server 8123
```

**Usa questo per vedere l'effetto di una modifica prima di pushare.** `main` fa deploy automatico su GitHub Pages (`https://advlabbik.github.io/camino-olga/`), cioè in produzione.

**Simulazione**: `?pos=lat,lon&now=2026-09-13T08:40:00` — l'app crede di essere lì in quel momento (niente GPS). Il meteo resta quello vero di oggi (l'API non prevede il futuro). Dopo aver giocato, Setup → «Cancella tutto» → reincollare la configurazione, o il diario si sporca di tappe simulate.

## Struttura

| File/cartella | Contenuto |
|---|---|
| `index.html` | Markup, tab (Oggi / Mappa / Diario / Schede / Setup) |
| `assets/app.js` | Tutta la logica: snap GPS sulla traccia, meteo Open-Meteo multi-punto, motore «dove dormo», proiezioni su mediana reale, alert per km/data, frasi con pietre miliari, diario, setup/import |
| `assets/map.js` | Vista percorso (caricata solo quando si apre il tab Mappa): mappa Esri con tracce e POI a livelli, **altimetria interattiva** — trascini sul profilo e il cursore si muove sulla mappa, con quota e residuo km/D+ (pattern tg-guida) |
| `assets/style.css` | Design system — blu segnaletica `#0F4C97` + giallo freccia `#DFA00A`, tema chiaro/scuro automatico |
| `assets/vendor/` | Leaflet self-hosted |
| `data/track.json` | Traccia OSM (ODbL): Francese con varianti 1A/1B + Epilogo Fisterra/Muxía + costiera, quote e km progressivi. Si rigenera con `tools/build_track.py` |
| `data/pois.json` | 4.687 POI (acqua/cibo/negozi/dormire/farmacie/ATM) sul corridoio di 400 m. Si rigenera con `tools/build_pois.py` |
| `data/localities.json` | 671 località con conteggio servizi e letti |
| `data/alerts.json` | Alert di percorso per km/data (bivio Napoléon, San Mateo, gap d'acqua…) |
| `data/sellos.json` | Regola dei timbri + i 16 timbri famosi |
| `data/phrases.json` | Frasi di supporto per contesto + pietre miliari agganciate ai km |
| `data/status.json` | Stato aperto/chiuso con timestamp (→ controllo notturno, in arrivo) |
| `manifest.webmanifest`, `sw.js` | PWA. Service worker **network-first** con cache di salvataggio. **Bumpare `V` in `sw.js` a ogni modifica dei file** |
| `tools/` | Script riproducibili di build dati (Overpass con cache in `tools/cache/`, gitignorata) |

## Prima apertura

Al primo avvio (e finché non risulta installata) l'app mostra una card di benvenuto con la **procedura passo passo per mettersi in Home**, adattata alla piattaforma — iPhone/Safari, iPhone con altro browser, Android (con il pulsante nativo quando il browser espone `beforeinstallprompt`), desktop. Si chiude con «Fatto» (definitivo, `S.homeDone`) o «Più tardi» (ricompare dopo 20 ore). Le stesse istruzioni restano sempre nella prima scheda di **Schede**.

**Trappola iOS che giustifica l'ordine delle operazioni** — su iPhone la web app aggiunta alla Home ha un contenitore di storage **separato** da Safari. Se la configurazione viene incollata nel browser e solo dopo si aggiunge l'app alla Home, l'app installata parte vuota e il setup va rifatto. Per questo la card dice esplicitamente di installare **prima** e caricare il viaggio **dopo**, dall'icona.

## Il piano del mattino

«Parto» costruisce il piano sull'**orizzonte giusto** — la **tappa intera** quando in configurazione c'è il letto di stasera sullo stesso segmento (titolo «Oggi — da → a», km e D+ fino al letto), altrimenti i **prossimi 25 km**. Meteo, alert, nastro e timbri usano tutti quell'orizzonte.

**«Dove sono?»** — dopo la prima pressione il bottone cambia identità (📍) e le pressioni successive nella giornata aggiornano il piano dalla posizione corrente, con una card «Sei qui» in testa — località, km già fatti (via `walkedBetween`, regge i cambi di segmento), km al letto, ETA al passo reale e barra di avanzamento della tappa. La frase della mattina viene riusata (il pool non si brucia), salvo pietra miliare appena attraversata, che vince sempre.

**Timbri** — blocco dedicato con la regola del giorno (1, oppure 2 da Sarria e sull'Epilogo), **contatore tap-to-count** salvato in `S.days[].sellos`, i timbri famosi di oggi con la distanza, l'elenco delle località dove chiedere e il promemoria che l'alloggio di stasera timbra sempre. A «Fine tappa» l'app verifica il conteggio e insiste se manca. Sulla mappa il livello 📮 è acceso di default e i popup delle località ricordano che lì si può timbrare.

## Privacy — regola di architettura

**Nessun dato personale nel repo** (è pubblico). Prenotazioni, diario e posizioni vivono solo in `localStorage` sul telefono (chiave `bco_v1`), caricate una volta con incolla-JSON nel tab Setup. Il file di configurazione di Olga sta fuori dal repo, nella cartella Cowork del progetto. L'unica chiamata di rete dell'app è Open-Meteo con coordinate del percorso; i tile mappa si caricano solo aprendo il tab Mappa.

## Regole di scrittura (ereditate dalle app BAS)

- **Mai i due punti `:` nella prosa** rivolta a Olga (ok negli orari tipo 14:30).
- Niente dati inventati: dove i dati sono vecchi o mancanti l'app lo dice e degrada a «chiama per conferma» (guardrail del motore «dove dormo»).
- **Airbnb non si mette.** Nessun pulsante o link, mai (regola 15/8/2026, vale per tutti i progetti).

## Stay22

I link «Booking» del motore «dove dormo» passano da Stay22 Allez con **AID aziendale `adventurelabsrl`** (quello che incassa le commissioni — non cambiarlo) e campagna **`olgacamino`**, con coordinate della località e check-in stanotte. Così i pernottamenti prenotati da Olga sono tracciati come le mappe delle app evento.

## Deploy e metodo di lavoro

- Deploy automatico su **GitHub Pages da `main`**. Verificare **sempre in locale prima** di pushare.
- Bumpare `V` in `sw.js` a ogni modifica di file — o chi ha la PWA installata resta indietro di una versione.
- La build di Pages ogni tanto non parte da sola: se dopo qualche minuto serve ancora la versione vecchia, un commit vuoto la risveglia.
- README aggiornato **come parte del lavoro**, non dopo.

## Trappole note

- **Ogni file elencato in `SHELL` di `sw.js` deve esistere davvero.** Il precache è atomico (`addAll`), quindi un solo 404 fa fallire l'installazione del service worker e l'app resta senza offline, in silenzio. È già successo con `assets/icon-512.png`, referenziata prima di essere creata. Dopo ogni deploy vale un giro di `curl -o /dev/null -w '%{http_code}'` su tutti i file di SHELL.
- **Service worker network-first, non cache-first**: la primissima versione era cache-first e un client con la cache vecchia è crashato sui dati nuovi («DATA.loc is not iterable»). Chi ha rete deve vedere sempre l'ultima versione; la cache serve solo dove il segnale manca.
- `pois.json` e `localities.json` hanno un involucro `{meta, …}` con l'attribuzione ODbL — il loader lo spacchetta e tollera entrambi i formati.
- Le **fontane vicine si raggruppano** nel nastro (entro ~600 m, col conteggio): nei paesi ce ne sono anche 4-5 nello stesso km.
- Santiago geometricamente vive sull'**Epilogo al km 0** (il nodo OSM è più vicino a quella linea): il motore «dove dormo» la aggiunge come opzione speciale quando è a portata dal Francese.
- `fitBounds` sempre con `animate:false` (trappola ereditata da tg-guida: con l'animazione i segni si calcolano sulla vista sbagliata).
- Le quote della traccia vengono da Open-Meteo/Copernicus: i **totali D+ mostrati sono indicativi**, mai spacciarli per dati ufficiali di qualcuno.
- OSM ha buchi noti sui letti (es. Lorca km ~101 ha due albergue reali, censiti zero): finché non arriva la curatela manuale il motore mostra «letti non censiti» e resta prudente.
- Milestone e frasi scattano **solo attraversando** il punto (finestra 3,5 km): al primo avvio a metà cammino le pietre già alle spalle si archiviano in silenzio.

## Dati e attribuzioni

Traccia e POI derivati da **OpenStreetMap** — © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright); il dataset derivato in `data/` eredita la licenza. Quote: Open-Meteo Elevation (Copernicus DEM). Meteo: [Open-Meteo.com](https://open-meteo.com/). Tile mappa: Esri World Topo. Fonti editoriali (tappe, letti, chiusure): ricerche del 16/8/2026 con fonti citate, nella cartella Cowork del progetto.

## Cosa resta da fare

| Cosa | Stato |
|---|---|
| Controllo notturno aperto/chiuso → `status.json` (GitHub Action) | da costruire |
| Curatela manuale letti/telefoni per località chiave | da fare in sessione |
| Icona PNG per l'installazione su iOS (l'SVG su iPhone non basta) | da generare |
| Collaudo sul telefono di Olga + caricamento configurazione reale | prima della partenza (10/9) |
