#!/usr/bin/env bash
# Sobe o Radar inteiro e PROVA que subiu: containers, migração, build do front
# quando está velho, API, worker, túnel público, e uma verificação ponta a ponta
# pela URL pública.
#
# O motivo de existir: `up.sh` dorme 4s e imprime o status do curl. Num boot
# frio isso dá "HTTP 000" com o servidor perfeitamente no ar — uma mensagem que
# assusta sem informar. Aqui nada é declarado sem resposta medida, e qualquer
# etapa que falhe derruba o script com código de saída.
#
#   bash scripts/subir.sh              # tudo, com túnel
#   bash scripts/subir.sh --sem-tunel  # só local (4500)
#   bash scripts/subir.sh --build      # força rebuild do front
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v24.19.0/bin/node}"
PORTA="${PORTA:-4500}"
LOCAL="http://localhost:$PORTA"
COM_TUNEL=1
FORCAR_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --sem-tunel) COM_TUNEL=0 ;;
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

if [ "$COM_TUNEL" = 0 ]; then
  passo "pronto (sem túnel)"
  echo "  $LOCAL"
  exit 0
fi

passo "túnel público"
command -v cloudflared >/dev/null || { erro "cloudflared não está instalado"; exit 1; }
# `pkill -f` casaria com a própria linha de comando de quem chama e mataria o
# shell; e reaproveitar o log TRUNCANDO deixa o processo antigo escrevendo no
# mesmo arquivo em outro offset, o que enche o log de buracos.
pgrep -x cloudflared | xargs -r kill 2>/dev/null || true
sleep 2
LOG=/tmp/cloudflared-$PORTA-$(date +%H%M%S).log
setsid cloudflared tunnel --no-autoupdate --url "$LOCAL" > "$LOG" 2>&1 < /dev/null &
# Esperar a URL não basta: ela aparece antes de existir conexão registrada.
for _ in $(seq 1 60); do
  grep -aq "Registered tunnel connection" "$LOG" 2>/dev/null && break
  sleep 1
done
URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)
[ -z "${URL:-}" ] && { erro "o túnel não devolveu URL — veja $LOG"; tail -5 "$LOG"; exit 1; }
grep -aq "Registered tunnel connection" "$LOG" || { erro "URL sorteada mas nenhuma conexão registrada — veja $LOG"; exit 1; }
ok "túnel aberto e com conexão registrada"

# O DNS corporativo desta rede NÃO resolve *.trycloudflare.com (o apex resolve).
# Sem isto a verificação daria 000 em tudo e acusaria um túnel que está perfeito.
HOST=${URL#https://}
RESOLVE=()
# Nome recém-sorteado leva alguns segundos para existir no DNS — e o DNS desta
# rede às vezes não resolve *.trycloudflare.com de jeito nenhum (o apex resolve).
# Sem estas duas coisas a verificação acusa 000 num túnel perfeito.
for tentativa in $(seq 1 12); do
  if getent hosts "$HOST" >/dev/null 2>&1; then RESOLVE=(); DNS_OK=local; break; fi
  IP=$("$NODE" -e "const{Resolver}=require('dns');const r=new Resolver();r.setServers(['1.1.1.1','8.8.8.8']);r.resolve4(process.argv[1],(e,a)=>console.log(e?'':a[0]))" "$HOST" 2>/dev/null || true)
  if [ -n "${IP:-}" ]; then RESOLVE=(--resolve "$HOST:443:$IP"); DNS_OK=publico; break; fi
  sleep 3
done
case "${DNS_OK:-}" in
  local) ok "DNS resolve o host" ;;
  publico)
    erro "o DNS desta rede não resolve $HOST — verificando via DNS público ($IP)"
    echo "    (o túnel serve normalmente quem está fora; só este PC não abre a URL no navegador)" ;;
  *) erro "o host não resolveu em 36s, nem local nem público — a verificação abaixo vai falhar" ;;
esac

passo "verificação pela URL pública"
falhou=0
checa() { # rota, códigos aceitos, descrição
  local cod
  for _ in $(seq 1 12); do
    cod=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "${RESOLVE[@]}" "$URL$1" 2>/dev/null) || cod=000
    [ "$cod" != "000" ] && break
    sleep 2
  done
  if [[ " $2 " == *" $cod "* ]]; then ok "$3 (HTTP $cod)"; else erro "$3 devolveu HTTP $cod, esperado: $2"; falhou=1; fi
}
checa "/" "200" "landing"
# 302 é o certo: a busca exige sessão e manda para o login.
checa "/busca" "302 200" "busca (redireciona para o login)"
checa "/api/stats" "401" "API exige sessão pelo túnel"
[ -n "$LOTE" ] && checa "/lote/verificacao-$LOTE" "200" "página pública do lote $LOTE"

echo
if [ "$falhou" = 1 ]; then
  erro "o túnel subiu mas alguma rota não respondeu como esperado"
  echo "  $URL"
  exit 1
fi
printf '\033[1m  %s\033[0m\n' "$URL"
echo "$URL" > /tmp/radar-url.txt
echo
echo "  local: $LOCAL   ·   logs: /tmp/leilao-server.log /tmp/leilao-worker.log $LOG"
echo "  derrubar o túnel: pgrep -x cloudflared | xargs -r kill"
