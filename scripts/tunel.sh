#!/usr/bin/env bash
# Túnel Cloudflare: publica a app numa URL HTTPS pública, sem abrir porta no
# roteador. Útil porque a rede aqui é corporativa e o redirecionamento de porta
# depende de TI.
#
# Modo rápido (sem conta): a URL é sorteada e MUDA a cada execução.
# O túnel sai da máquina para a Cloudflare, então não há porta de entrada.
set -euo pipefail
PORTA="${1:-4500}"
LOG=/tmp/cloudflared-$PORTA.log

pkill -f "cloudflared.*--url http://localhost:$PORTA" 2>/dev/null || true
: > "$LOG"
setsid cloudflared tunnel --no-autoupdate --url "http://localhost:$PORTA" > "$LOG" 2>&1 < /dev/null &

echo "aguardando a URL..."
for _ in $(seq 1 40); do
  URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "${URL:-}" ]; then
  echo "não consegui obter a URL; veja $LOG"
  tail -5 "$LOG"
  exit 1
fi
echo
echo "  $URL"
echo
echo "Log: $LOG   |   Para derrubar: pkill -f cloudflared"
