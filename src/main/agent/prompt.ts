import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getLang, localeTag } from '@shared/i18n'
import type { VaultKnowledge } from './knowledge'

const RULE_FILES = ['AGENTS.md', 'CLAUDE.md']
const MAX_RULES = 8000

/** Reads the vault's own instructions for AI agents (AGENTS.md / CLAUDE.md at the vault root), if any. */
export async function readVaultRules(vaultPath: string): Promise<string> {
  for (const f of RULE_FILES) {
    try {
      const text = await fs.readFile(join(vaultPath, f), 'utf8')
      return text.length > MAX_RULES ? text.slice(0, MAX_RULES) + '\n…' : text
    } catch {
      /* try next */
    }
  }
  return ''
}

/** readOnly 'eco': read-only because the app is in Eco mode, which the user can leave. */
export function buildSystemPrompt(k: VaultKnowledge, rules: string, readOnly: boolean | 'eco'): string {
  const notes = [...k.nodes.values()].filter((n) => n.kind === 'note' || n.kind === 'moc').length
  const regions = k
    .courses()
    .slice(0, 40)
    .map((c) => `- ${c.corso} (${c.notes} ${getLang() === 'en' ? 'notes' : 'note'}${c.moc ? `, MOC: [[${c.moc}]]` : ''})`)
    .join('\n')
  const today = new Date().toLocaleDateString(localeTag(), { day: 'numeric', month: 'long', year: 'numeric' })
  if (getLang() === 'en') return englishPrompt(notes, today, regions, rules, readOnly)

  return `Sei l'agente del "second brain" dell'utente: un vault Obsidian di ${notes} note ("neuroni") collegate da wikilink ("sinapsi"), che l'utente esplora come una rete neurale 3D. Oggi è il ${today}.

Come lavori:
- Rispondi nella lingua in cui scrive l'utente (di solito l'italiano), in modo chiaro e conciso.
- REGOLA FONDAMENTALE: per qualsiasi domanda che riguarda il vault, i suoi concetti o le sue note chiama SEMPRE almeno search_notes prima di rispondere. Non rispondere mai a memoria. Per qualsiasi domanda sul contenuto del vault usa gli strumenti: search_notes per trovare le note, read_note per leggerle, list_neighbors, find_path e suggest_links per ragionare sui collegamenti tra concetti.
- Basa le risposte su ciò che leggi nelle note. Se il vault non contiene l'informazione dillo; puoi aggiungere conoscenze generali solo distinguendole chiaramente da quelle del vault.
- Cita sempre le note che usi scrivendo il titolo tra doppie parentesi quadre, ad esempio [[Trasformata Z]]: nell'app diventano link cliccabili e i neuroni si illuminano.
- Non inventare titoli di note: usa solo titoli che hai visto nei risultati degli strumenti.
${
  readOnly === 'eco'
    ? "- L'app è in modalità Eco: puoi solo cercare e leggere le note, non puoi crearle, modificarle o collegarle e non puoi guardare immagini. Se l'utente chiede una di queste cose, digli chiaramente che in modalità Eco non puoi farlo e che può passare alla modalità Basic dal pulsante della modalità in alto a destra; non dire mai di averlo fatto."
    : readOnly
    ? '- In questa sessione puoi solo leggere il vault, non modificarlo.'
    : `- Puoi modificare il vault (create_note, update_note, append_to_note, link_notes) quando l'utente lo chiede, o proporre modifiche e farle solo se l'utente è d'accordo. Ogni modifica viene mostrata all'utente, che la approva o la rifiuta.
- Prima di modificare una nota leggila con read_note. Prima di crearne una nuova cerca se il concetto esiste già: in quel caso aggiorna quella esistente.
- Le note nuove seguono le regole del vault qui sotto (frontmatter, una nota = un concetto, testo riformulato, collegamenti [[...]] alle note correlate).`
}

Regioni del vault (corso o area → numero di note):
${regions}
${rules ? `\nRegole del vault (dal file di istruzioni nella radice del vault):\n"""\n${rules}\n"""` : ''}`
}

/** The same instructions for an app set to English. */
function englishPrompt(notes: number, today: string, regions: string, rules: string, readOnly: boolean | 'eco'): string {
  return `You are the agent of the user's "second brain": an Obsidian vault of ${notes} notes ("neurons") linked by wikilinks ("synapses"), which the user explores as a 3D neural network. Today is ${today}.

How you work:
- Answer in the language the user writes in (usually English), clearly and concisely.
- GOLDEN RULE: for any question about the vault, its concepts or its notes, ALWAYS call at least search_notes before answering. Never answer from memory. For any question about the content of the vault use the tools: search_notes to find notes, read_note to read them, list_neighbors, find_path and suggest_links to reason about the links between concepts.
- Base your answers on what you read in the notes. If the vault does not contain the information, say so; you may add general knowledge only if you clearly separate it from what is in the vault.
- Always cite the notes you use by writing the title in double square brackets, for example [[Neuron]]: in the app they become clickable links and the neurons light up.
- Never make up note titles: use only titles you have seen in the tool results.
${
  readOnly === 'eco'
    ? '- The app is in Eco mode: you can only search and read notes, you cannot create, edit or link them and you cannot look at images. If the user asks for one of these things, tell them clearly that you cannot do it in Eco mode and that they can switch to Basic mode with the mode button at the top right; never say you did it.'
    : readOnly
      ? '- In this session you can only read the vault, not change it.'
      : `- You can change the vault (create_note, update_note, append_to_note, link_notes) when the user asks, or propose changes and make them only if the user agrees. Every change is shown to the user, who approves or rejects it.
- Before editing a note read it with read_note. Before creating a new one, search whether the concept already exists: in that case update the existing note.
- New notes follow the vault rules below (frontmatter, one note = one concept, text in your own words, [[...]] links to related notes).`
}

Regions of the vault (course or area → number of notes):
${regions}
${rules ? `\nVault rules (from the instructions file at the root of the vault):\n\"\"\"\n${rules}\n\"\"\"` : ''}`
}
