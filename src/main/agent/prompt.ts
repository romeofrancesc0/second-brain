import { promises as fs } from 'node:fs'
import { join } from 'node:path'
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
    .map((c) => `- ${c.corso} (${c.notes} note${c.moc ? `, MOC: [[${c.moc}]]` : ''})`)
    .join('\n')
  const today = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })

  return `Sei l'agente del "second brain" dell'utente: un vault Obsidian di ${notes} note ("neuroni") collegate da wikilink ("sinapsi"), che l'utente esplora come una rete neurale 3D. Oggi è il ${today}.

Come lavori:
- Rispondi sempre in italiano, in modo chiaro e conciso.
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
