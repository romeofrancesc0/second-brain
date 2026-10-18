# Second Brain on two computers (optional)

This is an optional, advanced setup. If you just want to use the app, download it from the [Releases page](../../../releases/latest) instead.

The idea: run the model on an **always-on home PC with a GPU** (this guide assumes Windows and an RTX card with 12 GB of VRAM), and use the app from a **laptop** that asks the PC for answers over a private network ([Tailscale](https://tailscale.com)). The **vault** is kept in sync between the two machines with [Syncthing](https://syncthing.net). From your phone you can talk to the agent through a **Telegram bot** that runs on the PC.

```
Laptop ──Tailscale──▶ Home PC: Ollama · app · agent service + Telegram bot
  ▲                       ▲
  └──── Syncthing ────────┘  (synced vault)
```

Throughout this guide the PC is called `homepc`; use any name you like.

## On the PC (e.g. via remote desktop)

1. Download this repo (zip from GitHub or `git clone`) and open `setup\windows`.
2. In PowerShell **as administrator**:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass; .\1-prepare-pc.ps1
   ```
   The script installs Git, Node, Ollama, Tailscale and Syncthing, opens Ollama to the Tailscale network only, enables SSH and disables sleep.
3. Sign in to Tailscale with the same account as the laptop. In the [Tailscale admin console](https://login.tailscale.com/admin/machines) rename the PC to `homepc` and disable *Key expiry*.
4. Reboot, then run `.\2-models.ps1`.
5. Set up the vault with Syncthing (section below). Then:
   ```powershell
   .\3-app-and-service.ps1 -Vault "C:\Users\<you>\SECONDBRAIN"
   ```
6. In the BIOS, set the PC to power on again after a power outage.

## On the laptop

1. Install Tailscale (macOS: `brew install --cask tailscale` or the App Store) and sign in with the same account.
2. Check: `curl http://homepc:11434/api/tags` must list the models.
3. In the app: **Agent → settings → Address** = `http://homepc:11434`, model `qwen3.5:9b`.
4. To free up RAM you can remove local models (`ollama rm qwen3.5:4b`) and quit Ollama on the laptop.

## Synced vault (Syncthing)

1. Open Syncthing on both machines (macOS: `brew install --cask syncthing-app`); the interface is at `http://127.0.0.1:8384`.
2. Laptop → *Add Remote Device* → paste the PC's ID (Actions → Show ID). Accept on the PC.
3. Laptop → share your vault folder with the PC. On the PC choose where to save it.
4. On both: *File Versioning* = *Simple* (keeps old versions).
5. Exclude the vault's `.git` folder from syncing: on the PC add `.git` to *Ignore Patterns*. That way there is a single git repo, on the laptop.

Avoid editing **the same note** on both computers at the same time.

## Telegram bot

1. On Telegram, message **@BotFather** → `/newbot` → copy the token.
2. On the PC open `%APPDATA%\Second Brain\server.json` and paste the token into `telegramToken`.
3. Restart the service: `Start-ScheduledTask 'Second Brain - service'`.
4. Message your bot: it replies with your Telegram ID. Put it in `allowedUsers` (e.g. `[123456789]`) and restart the service again.

Commands: free-form questions, `/nuova` (new conversation), `/stop`, `/modello` (change model). Vault changes arrive with **Approve / Reject / Undo** buttons.

## Claude Code on the PC from the laptop

```bash
ssh <windows-user>@homepc
```

On the PC: `npm i -g @anthropic-ai/claude-code`, then `claude` in the project folder.

## Updating the app

- PC: `setup\windows\update.ps1`
- Mac: `setup/mac/update.sh`
