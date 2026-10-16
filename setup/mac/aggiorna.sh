#!/bin/zsh
# Aggiorna l'app sul Mac all'ultima versione su GitHub e la reinstalla in Applicazioni.
set -e
cd "$(dirname "$0")/../.."
git pull
npm ci
pkill -f "Second Brain.app/Contents/MacOS/Second Brain$" || true
rm -rf dist && npm run app
ditto "dist/mac-arm64/Second Brain.app" "/Applications/Second Brain.app"
open "/Applications/Second Brain.app"
