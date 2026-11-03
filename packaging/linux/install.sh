#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Daniel Attinger
#
# Voice Review on Linux (also macOS, untested): install from this source folder (2026-10-22).
#
#   bash packaging/linux/install.sh [options]
#
#   --prefix DIR     where the app goes                     (default ~/.local/share/voice-review)
#   --python PY      add the packages to this Python's environment, keeping what it already has,
#                    instead of making a new one in DIR/venv
#   --wheels DIR     install the packages from these wheel files, with no internet
#   --models DIR     copy the models from DIR (hub/ = speech, safe/ = safe mode) instead of downloading
#   --model NAME     speech model: large-v3-turbo, distil-large-v3, small, small.en, base.en
#                    (default: large-v3-turbo on 8+ cores and 15+ GB RAM, else small)
#   --no-safe-mode   skip the 2.5 GB safe-mode model
#   --no-launcher    no 'voice-review' command in ~/.local/bin and no menu entry
#
# Models, settings and the recording queue go to ~/.local/share/VoiceReview (macOS:
# ~/Library/Application Support/VoiceReview), once per computer. After this, no internet is needed.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$SRC/packaging/linux"
PREFIX="$HOME/.local/share/voice-review"
PY="" WHEELS="" MODELS="" MODEL="" SAFE=1 LAUNCHER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift ;;
    --python) PY="$2"; shift ;;
    --wheels) WHEELS="$2"; shift ;;
    --models) MODELS="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --no-safe-mode) SAFE=0 ;;
    --no-launcher) LAUNCHER=0 ;;
    -h|--help) sed -n '5,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done
say() { echo; echo ">>> $*"; }
PREFIX="$(mkdir -p "$PREFIX" && cd "$PREFIX" && pwd)"

say "1/4  Python"
if [ -n "$PY" ]; then
  echo "    using $PY (its packages are kept; only missing ones are added)"
else
  BASE=""
  for c in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then BASE="$c"; break; fi
  done
  [ -n "$BASE" ] || { echo "Python 3.10 or newer is needed (3.12 recommended)."; exit 1; }
  if [ ! -x "$PREFIX/venv/bin/python" ]; then
    "$BASE" -m venv "$PREFIX/venv" || { echo "Could not make a virtual environment. On Ubuntu/Debian: sudo apt install python3-venv"; exit 1; }
  fi
  PY="$PREFIX/venv/bin/python"
  echo "    $("$PY" --version) in $PREFIX/venv"
fi
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "$PY is older than Python 3.10."; exit 1; }

say "2/4  Packages"
PIP=("$PY" -m pip install --disable-pip-version-check)
[ "$PY" = "$PREFIX/venv/bin/python" ] && PIP+=(-c "$SRC/packaging/constraints.txt")   # exact versions in our own environment
if [ -n "$WHEELS" ]; then
  PIP+=(--no-index --find-links "$WHEELS")
elif [ "$(uname)" = "Linux" ]; then
  PIP+=(--extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu)          # llama.cpp ready-built, no compiler needed
fi                                                                                       # macOS: llama.cpp compiles (Xcode command line tools)
"${PIP[@]}" -r "$HERE/requirements.txt"

say "3/4  The app -> $PREFIX"
if [ "$SRC" != "$PREFIX" ]; then
  mkdir -p "$PREFIX/app" "$PREFIX/scripts"
  cp -r "$SRC/app/." "$PREFIX/app/"            # over the old copy; files of our own already there are kept
  cp -r "$SRC/scripts/." "$PREFIX/scripts/"
  for f in LICENSE THIRD-PARTY-NOTICES.txt README.md; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$PREFIX/"; done
fi
find "$PREFIX/app" -name __pycache__ -prune -exec rm -rf {} +
VER="$(sed -n 's/^VERSION = "\(.*\)"/\1/p' "$PREFIX/app/server.py")"
echo "Voice Review, version $VER" > "$PREFIX/VERSION.txt"
echo "    version $VER"

say "4/4  Models (once per computer)"
ARGS=(--prefix "$PREFIX")
[ -n "$MODELS" ] && ARGS+=(--from "$MODELS")
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
[ "$SAFE" = 0 ] && ARGS+=(--no-safe-mode)
"$PY" "$HERE/fetch_models.py" "${ARGS[@]}"

if [ "$LAUNCHER" = 1 ]; then
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/voice-review" <<EOF
#!/usr/bin/env bash
# Voice Review: voice-review [file.pdf | video.mp4]   (no file: a file dialog opens)
export HF_HUB_OFFLINE=1
exec "$PY" "$PREFIX/app/server.py" "\$@"
EOF
  chmod +x "$HOME/.local/bin/voice-review"
  echo "    command: $HOME/.local/bin/voice-review"
  if [ "$(uname)" = "Linux" ]; then
    mkdir -p "$HOME/.local/share/applications"
    cat > "$HOME/.local/share/applications/voice-review.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Voice Review
Comment=Highlight a PDF or pause a video and dictate comments (speech stays on this computer)
Exec=$HOME/.local/bin/voice-review %f
Terminal=false
Icon=accessories-text-editor
MimeType=application/pdf;video/mp4;video/quicktime;video/webm;video/x-matroska;
Categories=Office;
EOF
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    echo "    menu entry: Voice Review (also under right-click > Open With on a PDF or a video)"
  fi
fi

echo
echo "Done. Voice Review $VER is installed in $PREFIX."
[ "$LAUNCHER" = 1 ] && echo "Start it from the menu, or type:  voice-review paper.pdf"
echo "The first time, the browser asks for the microphone: allow it. From now on it works without internet."
