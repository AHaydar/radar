#!/usr/bin/env bash
#
# NOTE: This script is for contributors and local development only.
#
# If you are an end user, do NOT use this script.
# Install radar via npm instead:
#
#   npm install -g radar-cc
#   radar setup
#
set -e

# Require Node.js >= 18
NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node.split('.')[0]))" 2>/dev/null)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node.js >= 22 is required (found: $(node --version 2>/dev/null || echo 'none'))"
  echo "  Install it from https://nodejs.org or use a version manager like nvm/fnm."
  exit 1
fi
echo "✔ Node.js $(node --version) detected"

echo "▶ Installing dependencies..."
npm install

echo "▶ Building..."
npm run build

echo "▶ Linking radar command..."
npm link

echo ""
echo "▶ Done. Run the following to finish setup:"
echo "    radar setup"
