#!/bin/zsh
# Update the app on the Mac to the latest version on GitHub and reinstall it in Applications.
set -e
cd "$(dirname "$0")/../.."
git pull
npm ci
pkill -f "Second Brain.app/Contents/MacOS/Second Brain$" || true
rm -rf dist && npm run app
ditto "dist/mac-arm64/Second Brain.app" "/Applications/Second Brain.app"
open "/Applications/Second Brain.app"
