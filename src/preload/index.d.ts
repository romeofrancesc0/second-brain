import type { SecondBrainApi } from '../shared/types'

declare global {
  interface Window {
    api: SecondBrainApi
  }
}
