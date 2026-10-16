# Second Brain — visualizzatore 3D + agente AI locale

App desktop per macOS che mostra un vault Obsidian come una rete neurale in tre dimensioni e permette di interrogarlo e modificarlo con un modello AI che gira **in locale**. Funziona offline: legge i file del vault dal disco e parla solo con server su `localhost`.

## Avvio

```bash
npm install
npm run dev        # sviluppo con hot reload
npm run start      # build + avvio della versione di produzione
npm run app        # crea "Second Brain.app" in dist/mac-arm64/ (trascinala in Applicazioni)
npm run dist       # crea il .dmg in dist/
npm run icon       # rigenera build/icon.png
```

Al primo avvio l'app propone i vault che Obsidian conosce già oppure una cartella a scelta. L'ultimo vault aperto viene riaperto automaticamente.

## Comandi

| Azione | Come |
| --- | --- |
| Ruotare | trascina con il mouse |
| Zoom verso un punto | scroll (zooma verso il cursore) |
| Volare dentro la rete | `W` `A` `S` `D` (+ `Q` / `E` giù/su, `Shift` per andare veloce) |
| Aprire un neurone | click (la camera ci vola sopra, il pannello mostra la nota) |
| Cercare | `⌘K` o `/` |
| Agente AI | `⌘J` o il pulsante **Agente** |
| Vista d'insieme | `H` |
| Riavvicinarsi al neurone selezionato | `F` |
| Deselezionare / spegnere l'evidenziazione | `Esc` o click nel vuoto |
| Nascondere / isolare un corso | click / ⌥ click nella legenda "Regioni" |

## Agente AI locale

L'agente usa un modello che gira sul tuo Mac tramite **Ollama** (consigliato) o **LM Studio**. Cerca e legge le note, ragiona sui collegamenti e, se glielo chiedi, crea o modifica i neuroni. Ogni modifica ti viene mostrata con una diff e va approvata.

### 1. Prepara il modello

Con Ollama (già installato su questo Mac):

```bash
open -a Ollama
```

```bash
ollama list
```

Serve un modello che supporti gli **strumenti** (tool calling). Il modello già scaricato, `qwen3.8-9b`, li supporta. Altre opzioni che funzionano bene: `qwen3:8b`, `llama3.1:8b`, `mistral-nemo`. Con 16 GB di RAM conviene restare sui modelli da 7–9B.

Facoltativo, per la ricerca **per significato** oltre che per parole chiave:

```bash
ollama pull nomic-embed-text
```

### 2. Collega l'app

1. Apri l'app e premi **Agente** (`⌘J`).
2. Se Ollama è avviato, l'app lo trova da sola e sceglie il primo modello di chat. Il pallino accanto al nome del modello è verde quando è tutto pronto.
3. Dall'icona delle impostazioni nel pannello puoi cambiare:
   - server: Ollama `http://localhost:11434`, oppure LM Studio `http://localhost:1234/v1` con il server avviato da LM Studio;
   - modello e lunghezza del contesto (16k è un buon compromesso);
   - temperatura e ragionamento esteso (più accurato ma più lento);
   - se la camera deve seguire l'agente nella vista 3D;
   - se applicare le modifiche senza chiedere conferma (sconsigliato);
   - il modello di embedding, con il pulsante **Crea indice** per la ricerca semantica.

### 3. Usalo

Esempi:

- «Riassumi i concetti principali di Fisica II»
- «Come sono collegati Machine learning e BigData nel mio vault?»
- «Che collegamenti mancano alla nota Trasformata Z?» (usa `suggest_links`: trova note affini non ancora collegate)
- «Crea una nota su X nel corso Y e collegala a [[Z]]»
- «Aggiungi alla nota Circuito RC un esempio numerico»

Mentre lavora, i neuroni che l'agente legge o modifica si illuminano e la camera ci vola sopra. A fine risposta si accendono tutti quelli citati. Le citazioni `[[…]]` nella chat sono cliccabili.

### Cosa può fare (strumenti)

| Lettura | Scrittura (con approvazione) |
| --- | --- |
| `list_courses` panoramica delle regioni | `create_note` nuova nota con frontmatter `area` / `corso` / `tags` |
| `search_notes` ricerca BM25 (+ semantica se c'è l'indice) | `update_note` riscrive il testo e/o i tag |
| `read_note` testo, metadati, link e backlink | `append_to_note` aggiunge un paragrafo |
| `list_neighbors` note collegate | `link_notes` crea una sinapsi con una frase di contesto |
| `list_notes` per corso, area o tag | |
| `find_path` catena di link tra due concetti | |
| `suggest_links` note affini non ancora collegate | |

Regole di sicurezza:
- l'agente legge le regole del vault (`AGENTS.md` o `CLAUDE.md` nella radice) e le segue quando scrive;
- non può modificare la cartella `Fonti/` né file che non siano `.md`;
- non può cancellare note;
- prima di ogni modifica salva un backup in `~/Library/Application Support/Second Brain/agent-changes/`, e il pulsante **Annulla modifica** nella chat ripristina la versione precedente. Le note create finiscono nel Cestino.

### Usare il vault da altre app (MCP)

Gli stessi strumenti sono disponibili come **server MCP**, così puoi usare il vault anche da LM Studio, Claude Desktop o da qualsiasi client MCP. Nelle impostazioni dell'agente, sezione *Usa il vault da altre app*, c'è la configurazione già pronta da copiare. Ha questa forma:

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "/Applications/Second Brain.app/Contents/MacOS/Second Brain",
      "args": ["/Applications/Second Brain.app/Contents/Resources/app.asar/out/main/mcp.js", "--vault", "/Users/francescoromeo/Desktop/SECONDBRAIN", "--data-dir", "/Users/francescoromeo/Library/Application Support/Second Brain"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

- **LM Studio**: scheda *Program* → *Install* → *Edit mcp.json*, incolla il blocco `second-brain`.
- **Claude Desktop**: *Impostazioni* → *Sviluppatore* → *Modifica configurazione* (`claude_desktop_config.json`).
- Aggiungi `"--read-only"` agli `args` per dare solo accesso in lettura.

Le modifiche fatte via MCP compaiono nella vista 3D in tempo reale, perché l'app osserva il vault.

## Come legge il vault

- **Neurone** = una nota `.md`, con dimensione in base al numero di collegamenti.
- **Sinapsi** = un `[[wikilink]]` o un link markdown tra note, risolto come fa Obsidian (nome file, percorso, alias, `#heading`).
- **Regione / colore**: il `corso` del frontmatter, poi `area`, poi la cartella. Le MOC (`MOC/…`) sono gli hub con l'anello.
- **Fonti** (PDF, immagini…) e **link non risolti** si possono mostrare dalle impostazioni.
- Le cartelle che iniziano con `.` (`.obsidian`, `.git`, …) vengono ignorate.

## Struttura

```
src/main/            processo Electron: finestra, IPC, parsing del vault, watcher
src/main/agent/      agente: client Ollama/OpenAI, strumenti, knowledge base, embedding, prompt
src/main/agentIpc.ts collega l'agente alla UI (chat, approvazioni, indice, MCP)
src/mcp/server.ts    server MCP stdio (build: out/main/mcp.js)
src/preload/         API esposta alla UI (window.api)
src/shared/          tipi condivisi
src/renderer/        UI
  graph/             scena Three.js, shader, layout a forze (Web Worker), etichette
  ui/                pannello nota, chat agente, ricerca, legenda, impostazioni
```

## Sviluppo e test

- `SBV_USER_DATA=/una/cartella` usa una cartella dati separata (config, cache, backup): utile per provare l'agente su una **copia** del vault.
- `SBV_CAPTURE_STEPS` esegue script nella UI e salva screenshot, poi chiude l'app:

```bash
SBV_CAPTURE_STEPS='[{"wait":6000,"shot":"/tmp/overview.png"},{"js":"window.__brain().select(\"MOC/MOC BigData.md\")","wait":3000,"shot":"/tmp/moc.png"}]' npx electron .
```

## Prossimi passi

Vedi [roadmap.md](roadmap.md).
