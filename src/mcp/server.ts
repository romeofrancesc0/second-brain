/**
 * MCP server (stdio) exposing the Second Brain vault tools to external agent apps
 * (LM Studio, Claude Desktop, …). Runs without the Electron UI:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<Second Brain binary>" out/main/mcp.js --vault <path> [--data-dir <dir>] [--read-only]
 *   node out/main/mcp.js --vault <path>
 *
 * stdout is the protocol channel: log only to stderr.
 */
import { promises as fs, watch } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_AI, type AiSettings } from '@shared/types'
import { EmbeddingIndex } from '../main/agent/embeddings'
import { VaultKnowledge } from '../main/agent/knowledge'
import { createClient } from '../main/agent/llm'
import { buildSystemPrompt, readVaultRules } from '../main/agent/prompt'
import { TOOLS, type ToolContext } from '../main/agent/tools'
import { scanVault } from '../main/vault'
import { secondBrainDataDir } from '../main/platform'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const log = (...a: unknown[]): void => console.error('[second-brain-mcp]', ...a)

async function main(): Promise<void> {
  const vaultPath = arg('--vault')
  if (!vaultPath) {
    log('uso: mcp.js --vault <percorso del vault> [--data-dir <dir>] [--read-only]')
    process.exit(2)
  }
  const dataDir = arg('--data-dir') ?? secondBrainDataDir()
  const readOnly = process.argv.includes('--read-only')

  // same AI settings as the app: used only to embed queries when a semantic index exists
  let ai: AiSettings = { ...DEFAULT_AI }
  try {
    ai = { ...DEFAULT_AI, ...(JSON.parse(await fs.readFile(join(dataDir, 'config.json'), 'utf8')).ai ?? {}) }
  } catch {
    /* defaults */
  }
  const index = ai.embedModel ? await EmbeddingIndex.load(dataDir, vaultPath, ai.embedModel) : null

  let knowledge = new VaultKnowledge(vaultPath, await scanVault(vaultPath))
  knowledge.embeddings = index
  const rescan = async (): Promise<void> => {
    knowledge = new VaultKnowledge(vaultPath, await scanVault(vaultPath))
    knowledge.embeddings = index
  }
  let timer: NodeJS.Timeout | null = null
  try {
    watch(vaultPath, { recursive: true }, (_e, f) => {
      if (!f || f.split(/[\\/]/).some((p) => p.startsWith('.'))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void rescan().catch((err) => log('rescan', err)), 800)
    })
  } catch (err) {
    log('watch non disponibile', err)
  }

  const ctx: ToolContext = {
    vaultPath,
    dataDir,
    knowledge: () => knowledge,
    refresh: rescan,
    // the MCP client (LM Studio, Claude…) asks the user before calling a tool
    approve: async () => true,
    embedQuery: async (text) => {
      if (!index) return null
      try {
        const [v] = await createClient(ai).embed(ai.embedModel, [text])
        return Float32Array.from(v)
      } catch {
        return null
      }
    }
  }

  const tools = TOOLS.filter((t) => !readOnly || !t.write)
  const server = new Server(
    { name: 'second-brain', version: '0.2.0' },
    { capabilities: { tools: {} }, instructions: buildSystemPrompt(knowledge, await readVaultRules(vaultPath), readOnly) }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as { type: 'object'; properties?: Record<string, object> },
      annotations: { readOnlyHint: !t.write, destructiveHint: false }
    }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = tools.find((t) => t.name === req.params.name)
    if (!def) return { content: [{ type: 'text', text: `Strumento sconosciuto: ${req.params.name}` }], isError: true }
    try {
      const r = await def.run((req.params.arguments ?? {}) as Record<string, unknown>, ctx)
      return { content: [{ type: 'text', text: r.content }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Errore: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
  log(`pronto · vault ${vaultPath} · ${knowledge.notes.size} note${readOnly ? ' · sola lettura' : ''}${index ? ' · indice semantico' : ''}`)
}

main().catch((err) => {
  log(err)
  process.exit(1)
})
