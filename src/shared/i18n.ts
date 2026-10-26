import { EN } from './en'

/*
 * The source strings are the Italian ones: `t('Lettura del vault…')` returns them as they are, or the
 * English version from en.ts when the app language is English. A string with no English entry shows in
 * Italian, so a missing translation never breaks the screen. `{name}` placeholders are filled from vars.
 */
export type Lang = 'it' | 'en'

export const LANGS: { id: Lang; label: string }[] = [
  { id: 'it', label: 'Italiano' },
  { id: 'en', label: 'English' }
]

let current: Lang = 'it'

export const getLang = (): Lang => current
export const setLang = (l: Lang): void => {
  current = l === 'en' ? 'en' : 'it'
}

/** The language for a system locale such as "it-IT" or "en-US": Italian for Italian, English otherwise. */
export const langFromLocale = (locale: string | undefined): Lang => (locale?.toLowerCase().startsWith('it') ? 'it' : 'en')

/** BCP 47 tag for number and date formatting. */
export const localeTag = (): string => (current === 'en' ? 'en-US' : 'it-IT')

export function t(it: string, vars?: Record<string, string | number>): string {
  const text = current === 'en' ? (EN[it] ?? it) : it
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text
}
