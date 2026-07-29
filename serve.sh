#!/usr/bin/env bash
# Browsers refuse ES module imports and fetch() over file://, so serve the folder.
PORT="${1:-8731}"
cd "$(dirname "$0")"
echo "http://localhost:$PORT/"
exec python3 -m http.server "$PORT"
