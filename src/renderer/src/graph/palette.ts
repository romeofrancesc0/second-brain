import { t } from '@shared/i18n'
import { Color } from 'three'

// Muted, mid-luminance colours: distinguishable clusters without a neon look.
const CURATED = [
  '#7aa6d6', // steel blue
  '#c88aa8', // dusty rose
  '#9b8fd1', // lavender
  '#6fb5a8', // sea green
  '#d8b36e', // sand
  '#93b97c', // sage
  '#d98a7a', // terracotta
  '#79a9b8', // slate teal
  '#c5a0c9', // mauve
  '#b4bd72', // olive
  '#88b8d8', // sky
  '#dda07a', // apricot
  '#a7a3d8', // periwinkle
  '#7fbf9f', // jade
  '#d1c27a', // straw
  '#cf8f9d', // old pink
  '#7fc0c4', // aqua grey
  '#a9c495', // moss
  '#b893c4', // orchid
  '#9fb0cf' // blue grey
]

export function buildPalette(groupsBySize: string[]): Map<string, Color> {
  const map = new Map<string, Color>()
  groupsBySize.forEach((g, i) => {
    if (g === t('Non risolti')) map.set(g, new Color('#7d8293'))
    else if (i < CURATED.length) map.set(g, new Color(CURATED[i]))
    else map.set(g, new Color().setHSL(((i * 137.508) % 360) / 360, 0.38, 0.64))
  })
  return map
}
