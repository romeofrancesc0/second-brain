// Downloads the llama.cpp server used by the built-in agent into resources/llama/<target>/.
// Run: node scripts/fetch-llama.cjs [mac-arm64] [mac-x64] [win-x64]   (default: this computer)
// The release is pinned and every archive is checked against its SHA-256 before use.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const RELEASE = 'b11756'
const TARGETS = {
  'mac-arm64': { asset: `llama-${RELEASE}-bin-macos-arm64.tar.gz`, sha256: 'f86b5eb838b985a17587e794dee9c6b34193aca6dceec018031a4ba7951fb7e6' },
  'mac-x64': { asset: `llama-${RELEASE}-bin-macos-x64.tar.gz`, sha256: '6d71968268a01ae975acde18441a70b2c7ba128b7a127f46b5ced4e8c5dd4eca' },
  // Vulkan for any GPU vendor; the archive also has the CPU backends, used when there is no Vulkan driver
  'win-x64': { asset: `llama-${RELEASE}-bin-win-vulkan-x64.zip`, sha256: '75ce69fdda503c3d6d3b3401f61369bd072194746ec65fbbc5fd7e749edd2914' }
}

const root = path.join(__dirname, '..', 'resources', 'llama')
const cache = path.join(root, '.cache')

/** The server and the libraries it loads; the other tools in the archive are left out. */
function wanted(target, name) {
  if (target.startsWith('mac')) return name === 'llama-server' || name === 'libllama-server-impl.dylib' || /^lib[\w-]+\.0\.dylib$/.test(name)
  if (name === 'llama-server.exe' || name === 'llama-server-impl.dll') return true
  return name.endsWith('.dll') && !name.endsWith('-impl.dll')
}

async function download(url, file, sha256) {
  if (fs.existsSync(file) && hash(file) === sha256) return
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  if (hash(file) !== sha256) {
    fs.rmSync(file, { force: true })
    throw new Error(`${path.basename(file)}: checksum diverso da quello atteso`)
  }
}

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function fetchTarget(target) {
  const t = TARGETS[target]
  if (!t) throw new Error(`target sconosciuto: ${target} (${Object.keys(TARGETS).join(', ')})`)
  const dest = path.join(root, target)
  const stamp = path.join(dest, 'RELEASE')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === RELEASE) return console.log(`${target}: già pronto (${RELEASE})`)

  fs.mkdirSync(cache, { recursive: true })
  const archive = path.join(cache, t.asset)
  await download(`https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${t.asset}`, archive, t.sha256)

  const tmp = fs.mkdtempSync(path.join(cache, 'x-'))
  // bsdtar reads both .tar.gz and .zip (macOS and Windows 10+ ship it as `tar`)
  execFileSync('tar', ['-xf', archive, '-C', tmp])
  const dir = fs.readdirSync(tmp).length === 1 && fs.statSync(path.join(tmp, fs.readdirSync(tmp)[0])).isDirectory() ? path.join(tmp, fs.readdirSync(tmp)[0]) : tmp

  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  let n = 0
  for (const name of fs.readdirSync(dir)) {
    if (!wanted(target, name)) continue
    // copy the real file under the name the binaries link to (no symlinks in the app bundle)
    fs.copyFileSync(fs.realpathSync(path.join(dir, name)), path.join(dest, name))
    n++
  }
  if (target.startsWith('mac')) fs.chmodSync(path.join(dest, 'llama-server'), 0o755)
  fs.writeFileSync(stamp, RELEASE + '\n')
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`${target}: ${n} file in ${path.relative(process.cwd(), dest)}`)
}

const here = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [here]
;(async () => {
  for (const t of targets) await fetchTarget(t)
})().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
