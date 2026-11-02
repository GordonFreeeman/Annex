#!/bin/sh
# Serves Annex on http://localhost:27180 so Chrome/Edge can install it as an app.
cd "$(dirname "$0")"
URL=http://localhost:27180/
( sleep 1; (command -v xdg-open >/dev/null && xdg-open "$URL") || (command -v open >/dev/null && open "$URL") ) >/dev/null 2>&1 &
echo "Annex is served at $URL (local only). Ctrl+C to stop."
exec python3 -m http.server 27180 --bind 127.0.0.1
