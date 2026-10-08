#!/usr/bin/env bash
# Sobe o Radar inteiro e PROVA que subiu: containers, migração, build do front
# quando está velho, API, worker, e uma verificação ponta a ponta local.
#
# O motivo de existir: `up.sh` dorme 4s e imprime o status do curl. Num boot
# frio isso dá "HTTP 000" com o servidor perfeitamente no ar — uma mensagem que
# assusta sem informar. Aqui nada é declarado sem resposta medida, e qualquer
# etapa que falhe derruba o script com código de saída.
#
#   bash scripts/subir.sh              # tudo, local (4500)
#   bash scripts/subir.sh --build      # força rebuild do front
set -euo pipefail
cd "$(dirname "$0")/.."

# v24.19.0 ficou pra trás quando o nvm atualizou: o caminho fixo quebrava o
# script inteiro. Agora: NODE_BIN, senão o node do PATH, senão a última versão
# instalada pelo nvm.
NODE="${NODE_BIN:-$(command -v node 2>/dev/null || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)}"
[ -x "$NODE" ] || { echo "node não encontrado — instale via nvm ou exporte NODE_BIN" >&2; exit 1; }
PORTA="${PORTA:-4500}"
LOCAL="http://localhost:$PORTA"
FORCAR_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) FORCAR_BUILD=1 ;;
    *) echo "opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

passo() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
erro()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }

passo "containers"
docker compose up -d >/dev/null
for _ in $(seq 1 60); do
  docker exec leilao-db pg_isready -U leilao >/dev/null 2>&1 && break
  sleep 1
done
docker exec leilao-db pg_isready -U leilao >/dev/null 2>&1 || { erro "Postgres não respondeu em 60s"; exit 1; }
ok "Postgres pronto"
docker exec leilao-redis redis-cli ping >/dev/null 2>&1 && ok "Redis pronto" || erro "Redis mudo (a fila vai falhar)"

passo "migração"
"$NODE" --env-file=.env node_modules/.bin/tsx scripts/migrate.ts >/dev/null
ok "esquema em dia"

passo "front"
CASCA=app-busca/dist/client/index.html
# Rebuild só quando alguma fonte é mais nova que o build: depois de um reboot é
# fácil servir um bundle velho sem perceber, e o sintoma é "a correção sumiu".
if [ "$FORCAR_BUILD" = 1 ] || [ ! -f "$CASCA" ] || [ -n "$(find app-busca/src app-busca/index.html -newer "$CASCA" -print -quit 2>/dev/null)" ]; then
  (cd app-busca && npm run build >/dev/null 2>&1) || { erro "o build do front falhou"; exit 1; }
  ok "front reconstruído"
else
  ok "build já está à frente das fontes"
fi

passo "API e worker"
pgrep -f "tsx src/server.ts" | xargs -r kill 2>/dev/null || true
pgrep -f "tsx src/queue/worker.ts" | xargs -r kill 2>/dev/null || true
sleep 1
setsid "$NODE" --env-file=.env node_modules/.bin/tsx src/server.ts > /tmp/leilao-server.log 2>&1 < /dev/null &
setsid "$NODE" --env-file=.env node_modules/.bin/tsx src/queue/worker.ts > /tmp/leilao-worker.log 2>&1 < /dev/null &

# Espera por RESPOSTA, não por relógio. 401 é sucesso: significa que a API está
# de pé e a sessão está sendo exigida.
for _ in $(seq 1 90); do
  # `|| echo 000` CONCATENA: o curl já imprime 000 pelo -w e o echo soma outro,
  # virando "000000" — diferente de "000", e o laço de espera saía na 1ª volta.
  COD=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$LOCAL/api/stats" 2>/dev/null) || COD=000
  [ "$COD" != "000" ] && break
  sleep 1
done
[ "${COD:-000}" = "000" ] && { erro "a API não respondeu em 90s — veja /tmp/leilao-server.log"; tail -5 /tmp/leilao-server.log; exit 1; }
ok "API responde em $LOCAL (HTTP $COD)"
grep -q "worker de coleta no ar" /tmp/leilao-worker.log 2>/dev/null && ok "worker de coleta no ar" || erro "worker ainda não anunciou (veja /tmp/leilao-worker.log)"

# Um lote aberto de verdade, para provar a página pública em vez de supor.
LOTE=$(docker exec leilao-db psql -U leilao -d leilao -t -A -c \
  "select id from lots where status not in ('encerrado','vendido') limit 1" 2>/dev/null | tr -d '[:space:]')

passo "verificação ponta a ponta local"
falhou=0
checa() { # rota, códigos aceitos, descrição
  local cod
  for _ in $(seq 1 12); do
    cod=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$LOCAL$1" 2>/dev/null) || cod=000
    [ "$cod" != "000" ] && break
    sleep 2
  done
  if [[ " $2 " == *" $cod "* ]]; then ok "$3 (HTTP $cod)"; else erro "$3 devolveu HTTP $cod, esperado: $2"; falhou=1; fi
}
checa "/" "200" "landing"
# 302 é o certo: a busca exige sessão e manda para o login.
checa "/busca" "302 200" "busca (redireciona para o login)"
checa "/api/vitrine" "200" "API de vitrine"
checa "/api/stats" "200 401" "API de stats"
[ -n "$LOTE" ] && checa "/lote/verificacao-$LOTE" "200" "página pública do lote $LOTE"

echo
if [ "$falhou" = 1 ]; then
  erro "alguma rota local não respondeu como esperado"
  echo "  logs: /tmp/leilao-server.log /tmp/leilao-worker.log"
  exit 1
fi
printf '\033[1m  %s\033[0m\n' "$LOCAL"
echo
echo "  logs: /tmp/leilao-server.log /tmp/leilao-worker.log"
