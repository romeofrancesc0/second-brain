# Scarica i modelli. RTX 5070 12 GB: il 9B sta tutto nella VRAM ed è veloce.
#   .\2-modelli.ps1
ollama pull qwen3.5:9b        # modello principale (circa 6-7 GB)
ollama pull qwen3.5:4b        # alternativa leggera
ollama pull nomic-embed-text  # ricerca per significato
ollama list
Write-Host "Prova rapida:" -ForegroundColor Cyan
ollama run qwen3.5:9b "Rispondi solo: funziono" --verbose
