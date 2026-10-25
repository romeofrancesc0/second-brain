# Second Brain

**Explore your Obsidian vault as a 3D neural network — and talk to it with a local AI agent.**

Second Brain is a desktop app that turns a folder of Markdown notes into an interactive 3D graph: every note is a neuron, every `[[wikilink]]` is a synapse. An agent powered by a model running **on your own machine** — built into the app, or through [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) — can search, read, connect and edit your notes. Your notes never leave the computer: the app reads the vault from disk, and the only download is the model, once, when you ask for it.

The interface is in English and Italian (Settings → Theme → Language).

## Download

Grab the latest build from the [**website**](https://www.romeo-francesco.it/secondbrain) or the [**downloads page**](https://github.com/romeofrancesc0/second-brain-releases/releases/latest):

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `Second-Brain-mac-arm64.dmg` |
| macOS, Intel | `Second-Brain-mac-x64.dmg` |
| Windows (64-bit) | `Second-Brain-win-x64.exe` |

### macOS: first launch

The app is not yet signed with an Apple Developer ID, so macOS will refuse to open it the first time. After dragging it into **Applications**, open it once, then go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Second Brain (on macOS 14 and earlier, right-click the app → **Open** → **Open** also works). Or run:

```bash
xattr -cr "/Applications/Second Brain.app"
```

### Windows: first launch

The installer is not code-signed, so SmartScreen may warn you. Click **More info** → **Run anyway**.

### First launch: setup

The installer stays small (a couple of hundred MB at most): the AI model is not inside it. The first time you open the app, a short setup asks:

1. **Language** — English or Italiano.
2. **Local agent** — whether to download it, and which model: **Qwen 3.5 4B** (3.4 GB, fine with 8–16 GB of memory), **Qwen 3.5 9B** (6.6 GB, best with 24 GB or more), or both. The recommended one for your computer is preselected. The download runs in the background while you use the app; you can pause and resume it.
3. **Demo vault** — a small ready-made vault of about twenty linked notes (brain, AI, study methods) in a folder you choose, to try everything without preparing anything.

You can skip both downloads and do them later from the agent panel.

## Features

- **3D graph of your vault** — one neuron per note, sized by number of connections; one colour and region per course/area.
- **Three views**, all in 3D (switch with `1` `2` `3` or in Settings → Theme):
  - **Nebula** — the cinematic neural network;
  - **Minimal** — the same network with plain points and lines, light, dark or system tone;
  - **Hologram** — a holographic 3D brain that contains the network; as you fly closer the shell fades out and the neurons appear.
- **Reading panel** with Markdown, LaTeX, callouts, images, outgoing links and backlinks.
- **Local AI agent** with streaming chat, read and write tools, diffs you approve, automatic backups and undo. It runs a built-in model (no installation) or one from Ollama / LM Studio, and can look at the images in your notes.
- **Semantic search** (optional) with a local embedding model.
- **MCP server** exposing the same tools to LM Studio, Claude Desktop and any other MCP client.
- **Live updates** — the graph follows the vault when files change on disk.

## Controls

| Action | How |
| --- | --- |
| Rotate | drag with the mouse |
| Zoom toward a point | scroll (zooms toward the cursor) |
| Fly through the network | `W` `A` `S` `D` (+ `Q` / `E` down/up, `Shift` to go fast) |
| Open a neuron | click (the camera flies to it, the panel shows the note) |
| Search | `⌘K` / `Ctrl+K` or `/` |
| AI agent | `⌘J` / `Ctrl+J` or the **Agent** button |
| Settings | `⌘,` / `Ctrl+,` |
| Overview | `H` |
| Re-focus the selected neuron | `F` |
| Deselect / turn highlighting off | `Esc` or click on empty space |
| Hide / isolate a course | click / `⌥` click in the "Regions" legend |

## How the vault is read

- **Neuron** = a `.md` note, sized by its number of connections.
- **Synapse** = a `[[wikilink]]` or Markdown link between notes, resolved the way Obsidian does (file name, path, alias, `#heading`).
- **Region / colour** = the `corso` frontmatter field, then `area`, then the folder. Notes under `MOC/…` are hubs and are drawn with a ring.
- **Sources** (PDFs, images…) and **unresolved links** can be shown from the settings.
- Folders starting with `.` (`.obsidian`, `.git`, …) are ignored.

On first launch the app offers the vaults Obsidian already knows about, or any folder you pick. The last vault you opened is reopened automatically.

## Local AI agent

The agent uses a model running on your computer. It searches and reads notes, reasons about links and, when you ask, creates or edits notes. Every change is shown as a diff and needs your approval.

### 1. Set up a model

**Built-in (recommended).** Pick a model in the first-run setup, or open the agent (`⌘J` / `Ctrl+J`) and press **Download the recommended model**. The app runs it with [llama.cpp](https://github.com/ggml-org/llama.cpp): no other software needed.

**Ollama or LM Studio (advanced).** If you already use them, install [Ollama](https://ollama.com) and pull a model that supports **tool calling**:

```bash
ollama pull qwen3:8b
```

Other models that work well: `llama3.1:8b`, `mistral-nemo`. With 16 GB of RAM, stick to 7–9B models.

Optionally, for search by **meaning** in addition to keywords:

```bash
ollama pull nomic-embed-text
```

### 2. Connect the app

1. Open the app and press **Agent** (`⌘J` / `Ctrl+J`).
2. With the built-in model, the dot next to the model name turns green as soon as the download is finished. With Ollama running, the app finds it and picks the first chat model.
3. From the settings icon in the panel you can change:
   - the server: built-in (with the list of models to download), Ollama `http://localhost:11434`, or LM Studio `http://localhost:1234/v1` with its local server started;
   - the model and context length (16k is a good compromise);
   - temperature and extended reasoning (more accurate, slower);
   - whether the camera follows the agent in the 3D view;
   - whether to apply changes without asking (not recommended);
   - the embedding model, with the **Create index** button for semantic search.

### 3. Use it

Examples (the agent answers in the language you write in):

- "Summarise the main concepts of Physics II"
- "How are Machine Learning and BigData connected in my vault?"
- "Which links are missing from the note Z-Transform?" (uses `suggest_links`: finds related notes that are not linked yet)
- "Create a note about X in course Y and link it to [[Z]]"
- "Add a numerical example to the RC Circuit note"

While it works, the neurons the agent reads or edits light up and the camera flies to them. At the end of the answer, every cited note lights up. `[[…]]` citations in the chat are clickable.

### Tools

| Read | Write (with approval) |
| --- | --- |
| `list_courses` overview of the regions | `create_note` new note with `area` / `corso` / `tags` frontmatter |
| `search_notes` BM25 search (+ semantic if an index exists) | `update_note` rewrites the text and/or the tags |
| `read_note` text, metadata, links and backlinks | `append_to_note` appends a paragraph |
| `list_neighbors` linked notes | `link_notes` creates a synapse with a sentence of context |
| `list_notes` by course, area or tag | |
| `find_path` chain of links between two concepts | |
| `suggest_links` related notes that are not linked yet | |

Safety rules:

- the agent reads the vault's rules (`AGENTS.md` or `CLAUDE.md` in the vault root) and follows them when writing;
- it cannot modify the `Fonti/` folder or any non-`.md` file;
- it cannot delete notes;
- before every change it saves a backup to the app data folder (`~/Library/Application Support/Second Brain/agent-changes/` on macOS, `%APPDATA%\Second Brain\agent-changes\` on Windows), and the **Undo change** button in the chat restores the previous version. Notes it creates are moved to the Trash if undone.

### Use the vault from other apps (MCP)

The same tools are available as an **MCP server**, so you can use your vault from LM Studio, Claude Desktop or any MCP client. In the agent settings, under *Use the vault from other apps*, there is a ready-to-copy configuration. It looks like this (macOS):

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "/Applications/Second Brain.app/Contents/MacOS/Second Brain",
      "args": [
        "/Applications/Second Brain.app/Contents/Resources/app.asar/out/main/mcp.js",
        "--vault", "/path/to/your/vault",
        "--data-dir", "/Users/you/Library/Application Support/Second Brain"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

- **LM Studio**: *Program* tab → *Install* → *Edit mcp.json*, paste the `second-brain` block.
- **Claude Desktop**: *Settings* → *Developer* → *Edit Config* (`claude_desktop_config.json`).
- Add `"--read-only"` to `args` to give read-only access.

Changes made through MCP show up in the 3D view in real time, because the app watches the vault.

## Build from source

Requires Node.js 20.19+ (or 22.12+).

```bash
git clone https://github.com/romeofrancesc0/second-brain.git
cd second-brain
npm install
npm run dev          # development with hot reload
```

| Command | What it does |
| --- | --- |
| `npm run dev` | development with hot reload |
| `npm run start` | build and run the production version |
| `npm run typecheck` | TypeScript checks for main and renderer |
| `npm run app` | build `Second Brain.app` into `dist/mac-arm64/` (unpacked) |
| `npm run dist` | build the macOS `.dmg` into `dist/` |
| `npm run app:win` / `npm run dist:win` | the same for Windows (run on Windows) |
| `npm run icon` | regenerate `build/icon.png` |

## Project structure

```
src/main/            Electron main process: window, IPC, vault parsing, file watcher
src/main/agent/      agent: built-in llama.cpp server, Ollama/OpenAI client, model downloads, tools, knowledge base, embeddings, prompt
src/main/agentIpc.ts connects the agent to the UI (chat, approvals, index, MCP)
src/mcp/server.ts    stdio MCP server (built to out/main/mcp.js)
src/server/          always-on service with a Telegram bot (no UI)
src/preload/         API exposed to the UI (window.api)
src/shared/          shared types; i18n.ts and en/ hold the English translations (the source strings are Italian)
resources/demo-vault the demo vault (it/ and en/), copied where the user chooses in the first-run setup
resources/llama      llama.cpp binaries, fetched by scripts/fetch-llama.cjs (not committed)
src/renderer/        UI
  graph/             Three.js scene, shaders, force layout (Web Worker), labels
  ui/                note panel, agent chat, search, legend, settings
setup/               optional: run the model on a home PC and use it from your laptop
```

## Development and testing

- `SBV_USER_DATA=/some/folder` uses a separate data folder (config, cache, backups): handy for trying the agent on a **copy** of your vault. With an empty folder the app starts with the first-run setup.
- To translate a string, wrap the Italian text in `t()` from `@shared/i18n` and add its English version to the matching file in `src/shared/en/`; a string without an English entry shows in Italian.
- `SBV_CAPTURE_STEPS` runs scripted steps in the UI and saves screenshots, then quits:

```bash
SBV_CAPTURE_STEPS='[{"wait":6000,"shot":"/tmp/overview.png"},{"js":"window.__brain().select(\"MOC/MOC BigData.md\")","wait":3000,"shot":"/tmp/moc.png"}]' npx electron .
```

## Releasing

Releases are built by GitHub Actions. Bump `version` in `package.json`, then push a matching tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The workflow builds the macOS and Windows installers and attaches them to a new GitHub Release. File names do not include the version, so the links under [Download](#download) and `https://github.com/romeofrancesc0/second-brain/releases/latest/download/<file>` always point to the newest build.

## Roadmap

See [roadmap.md](roadmap.md).

## License

[MIT](LICENSE) © Francesco Romeo
