import { homedir } from 'node:os'
import { join } from 'node:path'

/** Per-user application data folder, the same one Electron uses for app.getPath('appData'). */
export function appDataDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

/** Where Obsidian keeps its list of vaults. */
export const obsidianConfigPath = (): string => join(appDataDir(), 'obsidian', 'obsidian.json')

/** Data folder of the Second Brain app (config, layouts, backups, index). */
export const secondBrainDataDir = (): string => join(appDataDir(), 'Second Brain')
