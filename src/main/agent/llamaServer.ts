import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

/*
 * The built-in provider runs llama.cpp's own server (llama-server) as a child process: it reads images
 * through the model's mmproj file, which node-llama-cpp cannot do. It listens on 127.0.0.1 only, on a
 * free port, behind a random key per launch, so other programs and web pages cannot use it.
 */

export interface ServerConfig {
  model: string
  /** Vision projector: without it the model reads text only. */
  mmproj?: string
  numCtx: number
}

export interface RunningServer {
  baseUrl: string
  apiKey: string
}

/** The server frees the model (and GPU memory) after this long without requests, and reloads it on the next. */
const IDLE_SLEEP_S = 120
const START_TIMEOUT_MS = 180_000
/** Last lines of the server's output, to explain why it stopped. */
const TAIL_CHARS = 8000

export class ServerError extends Error {
  constructor(
    message: string,
    readonly log: string
  ) {
    super(message)
  }
}

let proc: ChildProcess | null = null
let current: { key: string; ready: Promise<RunningServer> } | null = null
let tail = ''

/** Where the binaries are: in the app's resources once packaged, under resources/llama in development. */
export function serverBinary(): string {
  if (process.env.SB_LLAMA_SERVER) return process.env.SB_LLAMA_SERVER
  const target = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'llama', target, exe) : ''
  return packaged && existsSync(packaged) ? packaged : join(__dirname, '..', '..', 'resources', 'llama', target, exe)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

/** Starts the server for this model, or reuses the one already running with the same settings. */
export function ensureServer(cfg: ServerConfig, logDir: string): Promise<RunningServer> {
  const key = JSON.stringify(cfg)
  // the exit handler forgets a server that stopped, so a matching entry is running or starting
  if (current?.key === key) return current.ready
  const ready = (async () => {
    await stopServer()
    return start(cfg, logDir)
  })()
  current = { key, ready }
  ready.catch(() => {
    if (current?.ready === ready) current = null
  })
  return ready
}

async function start(cfg: ServerConfig, logDir: string): Promise<RunningServer> {
  const bin = serverBinary()
  if (!existsSync(bin)) throw new ServerError(`Il motore del modello integrato non è installato (${bin}).`, '')
  const port = await freePort()
  const apiKey = randomBytes(24).toString('hex')
  const args = [
    ['-m', cfg.model],
    cfg.mmproj ? ['--mmproj', cfg.mmproj] : [],
    ['--host', '127.0.0.1', '--port', String(port)],
    ['--no-webui', '--jinja', '-np', '1', '-c', String(cfg.numCtx), '-fa', 'auto'],
    ['--sleep-idle-seconds', String(IDLE_SLEEP_S)]
  ].flat()

  mkdirSync(logDir, { recursive: true })
  const log: WriteStream = createWriteStream(join(logDir, 'llama-server.log'), { flags: 'w' })
  tail = ''
  // the key goes through the environment, not the command line that other users can see
  const child = spawn(bin, args, { env: { ...process.env, LLAMA_API_KEY: apiKey }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  proc = child
  const onData = (b: Buffer): void => {
    log.write(b)
    tail = (tail + b.toString('utf8')).slice(-TAIL_CHARS)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (err) => {
      tail += `\n${err.message}`
      resolve(-1)
    })
    child.once('exit', (code) => resolve(code))
  })
  void exited.then(() => {
    log.end()
    if (proc === child) {
      proc = null
      current = null
    }
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await Promise.race([
      fetch(baseUrl + '/health').then((r) => r.status, () => 0),
      exited.then(() => -1)
    ])
    if (status === 200) return { baseUrl, apiKey }
    if (status === -1 || child.exitCode !== null) throw new ServerError(explain(tail), tail)
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new ServerError('Il modello integrato non è partito in tempo.', tail)
}

/** A short reason in Italian from the server's output; the full log stays in the data folder. */
export function explain(log: string): string {
  if (/out of memory|failed to allocate|insufficient memory|OutOfDeviceMemory|unable to allocate/i.test(log))
    return 'Memoria insufficiente per il modello integrato. Chiudi le app che stanno usando un altro modello (Ollama, LM Studio…) o molta memoria, poi riprova.'
  if (/failed to load model|invalid magic|gguf_init|error loading model/i.test(log)) return 'Il file del modello non si apre: scaricalo di nuovo dalle impostazioni dell\'agente.'
  if (/address already in use|couldn't bind/i.test(log)) return 'Il modello integrato non riesce ad aprire una porta locale: riprova.'
  return 'Il modello integrato si è fermato.'
}

/** The last lines the server wrote: they explain a request that failed because it stopped. */
export function serverTail(): string {
  return tail
}

export async function stopServer(): Promise<void> {
  const child = proc
  proc = null
  current = null
  if (!child || child.exitCode !== null) return
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  await gone
  clearTimeout(timer)
}
