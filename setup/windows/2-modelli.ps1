# Scarica i modelli. RTX 5070 12 GB: il 9B sta tutto nella VRAM ed è veloce.
#   .\2-modelli.ps1
$env:OLLAMA_HOST = '127.0.0.1:11434'  # il client non puo usare 0.0.0.0 su Windows
if (-not (Get-Process 'ollama app' -ErrorAction SilentlyContinue)) { Start-Process "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"; Start-Sleep 5 }
ollama pull qwen3.5:9b        # modello principale (circa 6-7 GB)
ollama pull qwen3.5:4b        # alternativa leggera
ollama pull nomic-embed-text  # ricerca per significato
ollama list
Write-Host "Prova rapida:" -ForegroundColor Cyan
ollama run qwen3.5:9b "Rispondi solo: funziono" --verbose
