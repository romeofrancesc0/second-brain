import { t } from '@shared/i18n'
import type { KnownVault } from '@shared/types'
import { icons } from './icons'

/** First-run screen: pick one of the vaults Obsidian knows about, or any folder. */
export class Welcome {
  onOpen?: (path: string) => void

  constructor(private el: HTMLElement) {
    el.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement
      const card = target.closest<HTMLElement>('[data-path]')
      if (card) return this.onOpen?.(card.dataset.path!)
      if (target.closest('[data-action=choose]')) {
        const path = await window.api.chooseVault()
        if (path) this.onOpen?.(path)
      }
      if (target.closest('[data-action=close]')) this.hide()
    })
  }

  async show(opts: { error?: string; closable?: boolean } = {}): Promise<void> {
    const vaults = (await window.api.getKnownVaults()).filter((v) => v.exists)
    this.el.innerHTML = `
      <div class="welcome-card glass">
        ${opts.closable ? `<button class="icon-btn sm close" data-action="close">${icons.close}</button>` : ''}
        <div class="orb"></div>
        <h1>Second Brain</h1>
        <p class="lead">${t('Esplora il tuo vault Obsidian come una rete neurale in tre dimensioni.')}</p>
        ${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ''}
        ${
          vaults.length
            ? `<h4>${t('Vault trovati da Obsidian')}</h4><div class="vault-list">${vaults.map((v) => vaultCard(v)).join('')}</div>`
            : `<p class="muted">${t('Nessun vault di Obsidian trovato su questo computer.')}</p>`
        }
        <button class="btn primary" data-action="choose">${icons.folder}${t('Scegli una cartella…')}</button>
      </div>`
    this.el.classList.remove('hidden')
  }

  hide(): void {
    this.el.classList.add('hidden')
  }
}

function vaultCard(v: KnownVault): string {
  return `<button class="vault-card" data-path="${esc(v.path)}">
    <span class="vi">${icons.vault}</span>
    <span class="vt"><b>${esc(v.name)}</b><small>${esc(v.path.replace(/^\/Users\/[^/]+/, '~'))}</small></span>
    <span class="go">${icons.forward}</span>
  </button>`
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
