import type { AppSettings, ViewMode } from '@shared/types'

export interface ViewInfo {
  id: ViewMode
  name: string
  tagline: string
  /** Number key that switches to this view. */
  key: string
}

export const VIEWS: ViewInfo[] = [
  { id: 'nebula', name: 'Nebulosa', tagline: 'Rete neurale 3D con atmosfera e profondità', key: '1' },
  { id: 'minimal', name: 'Minimal', tagline: 'Mappa pulita: punti, linee, nient’altro', key: '2' },
  { id: 'hologram', name: 'Ologramma', tagline: 'Un cervello olografico: avvicinati per vedere i neuroni', key: '3' }
]

const prefersLight = window.matchMedia('(prefers-color-scheme: light)')

/** The minimal view can be light; the other two are always dark. */
export function isLight(s: AppSettings): boolean {
  if (s.view !== 'minimal') return false
  return s.tone === 'light' || (s.tone === 'system' && prefersLight.matches)
}

export function onSystemToneChange(cb: () => void): void {
  prefersLight.addEventListener('change', cb)
}

export function backgroundOf(view: ViewMode, light: boolean): string {
  if (view === 'hologram') return '#03070c'
  if (view === 'minimal') return light ? '#f4f4f1' : '#111318'
  return '#090b11'
}
