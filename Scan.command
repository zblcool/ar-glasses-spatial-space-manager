#!/bin/bash
# Double-click in Finder: starts the 3D scanner (see tools/scan.mjs).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null; then
  # Finder starts a bare shell; pick up Homebrew / nvm installs.
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
fi
exec node tools/scan.mjs "$@"
