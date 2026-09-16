#!/usr/bin/env bash
# Sobe a POC inteira: containers, migração, API e worker de filas.
# setsid + caminho absoluto do node porque nohup sozinho morre junto com o shell
# que dispara o comando nesta máquina.
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v24.19.0/bin/node}"
docker compose up -d >/dev/null
until docker exec leilao-db pg_isready -U leilao >/dev/null 2>&1; do sleep 1; done
"$NODE" --env-file=.env node_modules/.bin/tsx scripts/migrate.ts
pgrep -f "tsx src/server.ts" | xargs -r kill 2>/dev/null || true
pgrep -f "tsx src/queue/worker.ts" | xargs -r kill 2>/dev/null || true
sleep 1
setsid "$NODE" --env-file=.env node_modules/.bin/tsx src/server.ts > /tmp/leilao-server.log 2>&1 < /dev/null &
setsid "$NODE" --env-file=.env node_modules/.bin/tsx src/queue/worker.ts > /tmp/leilao-worker.log 2>&1 < /dev/null &
sleep 4
curl -s -o /dev/null -w "API e interface em http://localhost:4500 -> HTTP %{http_code}\n" http://localhost:4500/api/stats
