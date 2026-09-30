#!/bin/sh
# Lance build_tiles.py dans un environnement Python dédié (tools/tiles/.cache/venv, ignoré par git).
# Variable PYTHON_VENV : chemin d'un venv existant à utiliser à la place.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
VENV=${PYTHON_VENV:-$HERE/.cache/venv}
if [ ! -x "$VENV/bin/python" ]; then
  mkdir -p "$HERE/.cache"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
fi
cd "$HERE"
exec "$VENV/bin/python" build_tiles.py "$@"
