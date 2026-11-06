#!/usr/bin/env sh
# Start Flickr Photo Analyzer (macOS / Linux). Run: ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org and run this again."
  exit 1
fi
exec node server.js "$@"
