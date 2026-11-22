#!/usr/bin/env bash
# Generic Linux installer for the standalone Nook binary.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f nook-linux-x64 ]; then
  echo "Run 'npm run build:linux' first."
  exit 1
fi

sudo install -m 0755 nook-linux-x64 /usr/local/bin/nook
sudo install -m 0644 packaging/nook.desktop /usr/share/applications/nook.desktop
sudo install -m 0644 public/assets/nook-icon.png /usr/share/icons/hicolor/64x64/apps/nook.png
sudo update-desktop-database 2>/dev/null || true
echo "Nook installed. Run 'nook' or launch it from your applications menu."
