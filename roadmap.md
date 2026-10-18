# Roadmap — Second Brain

## ✅ v0.1 — Visualizzatore 3D

- App desktop macOS (Electron), completamente offline.
- Legge il vault Obsidian: note, wikilink, frontmatter `area` / `corso` / `tags`, MOC, fonti.
- Rete 3D: un neurone per nota, una sinapsi per collegamento, un colore e una regione per corso.
- Navigazione: orbita, zoom verso il cursore, volo con WASD, click per volare su un neurone, ricerca ⌘K.
- Pannello di lettura con markdown, LaTeX, callout, immagini, link in uscita e backlink.
- Layout salvato tra le sessioni; aggiornamento automatico quando il vault cambia.

## ✅ v0.2 — Stile sobrio + agente AI locale

- Grafica più pulita: neuroni come sfere solide che si coprono in profondità, sinapsi sottili e desaturate, palette tenue, bloom minimo, meno etichette, interfaccia neutra.
- **Agente AI locale** (Ollama o LM Studio) nel pannello ⌘J:
  - chat in streaming;
  - strumenti di lettura (ricerca BM25 e semantica, lettura, vicini, percorsi, collegamenti mancanti) e di scrittura (crea, modifica, aggiungi, collega);
  - approvazione con diff, backup e annullamento;
  - neuroni che si illuminano mentre l'agente lavora.
- Ricerca semantica opzionale con un modello di embedding locale e indice incrementale.
- **Server MCP** con gli stessi strumenti, per usare il vault da LM Studio, Claude Desktop e altri client.

## ✅ v0.3 — Viste e impostazioni

- **Tre viste del grafo**, tutte in 3D, da scegliere in Impostazioni → Tema (o con i tasti `1` `2` `3`):
  - **Nebulosa**: la rete 3D cinematografica di sempre;
  - **Minimal**: la stessa rete 3D con punti e linee essenziali, tono chiaro, scuro o di sistema;
  - **Ologramma**: un cervello olografico 3D che contiene la rete; avvicinandosi l'involucro sfuma e compaiono i neuroni.
- **Finestra Impostazioni** (⌘,) a sezioni: Tema, Grafo, Navigazione, Vault, Agente AI, Scorciatoie; colore d'accento.
- Interfaccia con tema chiaro/scuro, barra in basso con zoom e vista d'insieme.

## 🔜 Prossimi passi

- **Conversazioni salvate**: cronologia delle chat, ripresa delle conversazioni passate.
- **Evidenziazione dal server MCP**: quando un'app esterna legge o modifica note via MCP, i neuroni si accendono anche nella vista 3D (oggi si vede solo l'aggiornamento del grafo).
- **Elaborazione dell'Inbox**: un comando che fa processare all'agente i file in `Inbox/` seguendo il workflow del `CLAUDE.md` del vault (creare neuroni, spostare le fonti), con revisione finale.
- **Inferenza sul grafo**:
  - vista "collegamenti suggeriti", con sinapsi tratteggiate da approvare in blocco;
  - rilevamento di note duplicate o troppo lunghe da dividere.
- **Più modelli**: modelli diversi per chat e strumenti, preset per hardware (8 / 16 / 32 GB).
- Timeline della crescita del vault, percorso più breve tra due concetti evidenziato nel 3D.
- Firma e notarizzazione dell'app; aggiornamenti automatici.
