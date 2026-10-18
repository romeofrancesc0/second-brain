# Roadmap — Second Brain

## ✅ v0.1 — 3D viewer

- Desktop app (Electron), fully offline.
- Reads the Obsidian vault: notes, wikilinks, `area` / `corso` / `tags` frontmatter, MOCs, sources.
- 3D network: one neuron per note, one synapse per link, one colour and region per course.
- Navigation: orbit, zoom toward the cursor, WASD flight, click to fly to a neuron, ⌘K search.
- Reading panel with Markdown, LaTeX, callouts, images, outgoing links and backlinks.
- Layout saved between sessions; automatic refresh when the vault changes.

## ✅ v0.2 — Sober style + local AI agent

- Cleaner graphics: solid spheres that occlude each other in depth, thin desaturated synapses, muted palette, minimal bloom, fewer labels, neutral interface.
- **Local AI agent** (Ollama or LM Studio) in the ⌘J panel:
  - streaming chat;
  - read tools (BM25 and semantic search, read, neighbours, paths, missing links) and write tools (create, edit, append, link);
  - approval with diff, backups and undo;
  - neurons light up while the agent works.
- Optional semantic search with a local embedding model and an incremental index.
- **MCP server** with the same tools, to use the vault from LM Studio, Claude Desktop and other clients.

## ✅ v0.3 — Views and settings

- **Three graph views**, all in 3D, selectable in Settings → Theme (or with the `1` `2` `3` keys):
  - **Nebula**: the cinematic 3D network;
  - **Minimal**: the same 3D network with essential points and lines, light, dark or system tone;
  - **Hologram**: a holographic 3D brain that contains the network; as you get closer the shell fades and the neurons appear.
- **Settings window** (⌘,) with sections: Theme, Graph, Navigation, Vault, AI agent, Shortcuts; accent colour.
- Light/dark interface, bottom bar with zoom and overview.

## 🔜 Next

- **Public releases**: signed and notarized builds, auto-update, a project website with a download button.
- **Interface translations**: the UI is currently in Italian; add English (and make the language selectable).
- **Saved conversations**: chat history, resume past conversations.
- **Highlighting from the MCP server**: when an external app reads or edits notes via MCP, the neurons light up in the 3D view too (today only the graph update is visible).
- **Inbox processing**: a command that makes the agent process the files in `Inbox/` following the vault's `CLAUDE.md` workflow (create neurons, move sources), with a final review.
- **Graph inference**:
  - a "suggested links" view, with dashed synapses to approve in bulk;
  - detection of duplicate notes or notes that are too long and should be split.
- **More models**: different models for chat and tools, presets per hardware (8 / 16 / 32 GB).
- Vault growth timeline, shortest path between two concepts highlighted in 3D.
