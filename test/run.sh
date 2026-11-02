#!/bin/sh
# Test runner: no proxy (the sandbox proxy would intercept LAN WebSockets)
cd "$(dirname "$0")"
exec env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy SMALL=${SMALL-1} node e2e.mjs
