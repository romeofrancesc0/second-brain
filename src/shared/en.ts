import { agent } from './en/agent'
import { app } from './en/app'
import { main } from './en/main'
import { ui } from './en/ui'
import { wizard } from './en/wizard'

/** English versions of the Italian source strings used with t(). One file per area, see en/. */
export const EN: Record<string, string> = { ...wizard, ...ui, ...agent, ...app, ...main }
