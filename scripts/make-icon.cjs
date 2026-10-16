// Renders build/icon.png (1024x1024) with Electron. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// Sober mark: a few softly lit spheres joined by thin threads on a dark graphite tile.
const nodes = [
  [512, 520, 92, '#9fb0cf'],
  [318, 342, 46, '#7aa6d6'],
  [716, 318, 54, '#c88aa8'],
  [770, 640, 40, '#93b97c'],
  [560, 790, 44, '#d8b36e'],
  [300, 700, 36, '#9b8fd1'],
  [520, 228, 28, '#79a9b8']
]
const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 6], [6, 2], [2, 3], [3, 4], [4, 5], [5, 1]]

const lines = edges
  .map(([a, b]) => `<line x1="${nodes[a][0]}" y1="${nodes[a][1]}" x2="${nodes[b][0]}" y2="${nodes[b][1]}" stroke="#c9cfdc" stroke-width="${a === 0 ? 7 : 5}" stroke-linecap="round" opacity="${a === 0 ? 0.42 : 0.24}"/>`)
  .join('')
const spheres = nodes
  .map(
    ([x, y, r, c], i) => `
  <radialGradient id="g${i}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="0.18" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0.55"/></radialGradient>
  <circle cx="${x}" cy="${y + r * 0.12}" r="${r * 1.04}" fill="#000" opacity="0.35"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="#262a35"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="url(#g${i})"/>`
  )
  .join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1f28"/><stop offset="1" stop-color="#0b0d13"/></linearGradient>
  <clipPath id="clip"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
</defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
<g clip-path="url(#clip)">${lines}${spheres}</g>
<rect x="101.5" y="101.5" width="821" height="821" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="3"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`))
  await new Promise((r) => setTimeout(r, 600))
  const img = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, img.toPNG())
  console.log('icon written to', out)
  app.quit()
})
