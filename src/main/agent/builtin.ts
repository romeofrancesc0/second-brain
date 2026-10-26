import { t } from '@shared/i18n'
import { join } from 'node:path'
import { ensureServer, explain, isMemoryError, ServerError, serverTail, stopServer } from './llamaServer'
import { ModelError, OpenAICompatClient, type ChatClient, type ChatOptions, type ChatResult } from './llm'
import { catalogModel, installedModels, installedVision, modelsDir, verifyModel } from './models'

/** Runs GGUF models with llama.cpp's server, started by the app (Metal on macOS, Vulkan/CPU on Windows). */
export class BuiltinClient implements ChatClient {
  constructor(private dataDir: string) {}

  async listModels(): Promise<string[]> {
    const ids = await installedModels(this.dataDir)
    if (!ids.length) throw new ModelError('no-model', t('Nessun modello scaricato.'))
    return ids
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const m = catalogModel(o.model)
    if (!m) throw new ModelError('no-model', t('Modello sconosciuto: {id}', { id: o.model }))
    // a damaged file can crash llama.cpp's loader: check it first (fast once verified)
    if (!(await verifyModel(this.dataDir, m.id)))
      throw new ModelError('no-model', t("Il file del modello era danneggiato e l'ho rimosso: scaricalo di nuovo dalle impostazioni dell'agente."))
    // without images (Eco) the vision file is not loaded: less memory and a faster start
    const mmproj = o.vision === false ? null : await installedVision(this.dataDir, m.id)
    let server
    try {
      server = await ensureServer({ model: join(modelsDir(this.dataDir), m.file), mmproj: mmproj ?? undefined, numCtx: o.numCtx }, join(this.dataDir, 'logs'))
    } catch (err) {
      if (err instanceof ServerError) throw new ModelError(isMemoryError(err.message) ? 'no-memory' : 'http', err.message)
      throw err
    }
    const client = new OpenAICompatClient(server.baseUrl + '/v1', {
      headers: { authorization: `Bearer ${server.apiKey}` },
      // Qwen 3.5 thinks by default: the template switch turns it off; sampling as its model card suggests
      extraBody: () => ({ chat_template_kwargs: { enable_thinking: o.think }, top_p: 0.8, top_k: 20 })
    })
    try {
      return await client.chat(o)
    } catch (err) {
      if ((err as Error).name === 'AbortError' || o.signal?.aborted) throw err
      // the server stopped during the request: say why
      if (err instanceof ModelError && err.code === 'connection') {
        const why = explain(serverTail())
        throw new ModelError(isMemoryError(why) ? 'no-memory' : 'http', why)
      }
      throw err
    }
  }

  async canSee(model: string): Promise<boolean> {
    return (await installedVision(this.dataDir, model)) !== null
  }

  async embed(): Promise<number[][]> {
    throw new ModelError('http', t('Il modello integrato non calcola embedding: la ricerca usa le parole chiave.'))
  }
}

/** Stops the server (and frees the model) before quitting. */
export function disposeBuiltin(): Promise<void> {
  return stopServer()
}
