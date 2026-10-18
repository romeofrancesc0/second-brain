# Download the models. On a 12 GB GPU the 9B model fits entirely in VRAM and is fast.
#   .\2-models.ps1
$env:OLLAMA_HOST = '127.0.0.1:11434'  # the client cannot use 0.0.0.0 on Windows
if (-not (Get-Process 'ollama app' -ErrorAction SilentlyContinue)) { Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"; Start-Sleep 5 }
ollama pull qwen3.5:9b        # main model (about 6-7 GB)
ollama pull qwen3.5:4b        # lightweight alternative
ollama pull nomic-embed-text  # search by meaning
ollama list
Write-Host "Quick test:" -ForegroundColor Cyan
ollama run qwen3.5:9b "Answer only: it works" --verbose
