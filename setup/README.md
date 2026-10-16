# Second Brain su due computer

Il modello gira sul **PC di casa a Palermo** (RTX 5070 12 GB), sempre acceso.
Il **Mac** usa l'app normalmente, ma chiede le risposte al PC tramite una rete privata (Tailscale).
Il **vault** è sincronizzato tra i due computer con Syncthing.
Dal telefono si usa il **bot Telegram**, che gira sul PC.

```
Mac ──Tailscale──▶ PC Palermo: Ollama (qwen3.5:9b) · app · servizio agente + bot Telegram
 ▲                    ▲
 └──── Syncthing ─────┘  (vault sincronizzato)
```

## Sul PC (via TeamViewer)

1. Scarica questo repo (zip da GitHub o `git clone`) e apri `setup\windows`.
2. PowerShell **come amministratore**:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass; .\1-prepara-pc.ps1
   ```
   Lo script installa Git, Node, Ollama, Tailscale e Syncthing, apre Ollama solo alla rete Tailscale, attiva SSH e disattiva la sospensione.
3. Accedi a Tailscale con lo stesso account del Mac. In [admin.tailscale.com](https://login.tailscale.com/admin/machines) rinomina il PC in `palermo` e disattiva *Key expiry*.
4. Riavvia, poi lancia `.\2-modelli.ps1`.
5. Prepara il vault con Syncthing (sezione sotto). Poi:
   ```powershell
   .\3-app-e-servizio.ps1 -Vault "C:\Users\<te>\SECONDBRAIN"
   ```
6. Nel BIOS imposta la riaccensione dopo un blackout.

## Sul Mac

1. Installa Tailscale (`brew install --cask tailscale` oppure dall'App Store) e accedi con lo stesso account.
2. Verifica: `curl http://palermo:11434/api/tags` deve elencare i modelli.
3. Nell'app: **Agente → impostazioni → Indirizzo** = `http://palermo:11434`, modello `qwen3.5:9b`.
4. Per liberare RAM puoi togliere i modelli locali: `ollama rm qwen3.5:4b` (e chiudere Ollama sul Mac).

## Vault sincronizzato (Syncthing)

1. Apri Syncthing su entrambi (sul Mac: `brew install --cask syncthing-app`), interfaccia su `http://127.0.0.1:8384`.
2. Mac → *Aggiungi dispositivo remoto* → incolla l'ID del PC (Azioni → Mostra ID). Accetta sul PC.
3. Mac → condividi la cartella `~/Desktop/SECONDBRAIN` con il PC. Sul PC scegli dove salvarla.
4. In entrambi: *Versionamento file* = *Semplice* (tiene le vecchie versioni).
5. La cartella `.git` del vault va esclusa dalla sincronizzazione: nel PC aggiungi `.git` agli *Schemi da ignorare*. Così resta un solo repo git, sul Mac.

Evita di modificare **la stessa nota** nello stesso momento sui due computer.

## Bot Telegram

1. Su Telegram scrivi a **@BotFather** → `/newbot` → copia il token.
2. Sul PC apri `%APPDATA%\Second Brain\server.json` e incolla il token in `telegramToken`.
3. Riavvia il servizio: `Start-ScheduledTask 'Second Brain - servizio'`.
4. Scrivi al bot: ti risponde con il tuo ID. Mettilo in `allowedUsers` (es. `[123456789]`) e riavvia di nuovo il servizio.

Comandi: domande libere, `/nuova`, `/stop`, `/modello`. Le modifiche al vault arrivano con i pulsanti **Approva / Rifiuta / Annulla**.

## Claude Code sul PC dal Mac

```bash
ssh <utente-windows>@palermo
```
Sul PC: `npm i -g @anthropic-ai/claude-code`, poi `claude` nella cartella del progetto.

## Aggiornare l'app

- PC: `setup\windows\aggiorna.ps1`
- Mac: `setup/mac/aggiorna.sh`
