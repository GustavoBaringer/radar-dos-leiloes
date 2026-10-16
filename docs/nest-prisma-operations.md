# Runbook operacional: migração NestJS/Prisma

**Estado: ainda sem implantação e sem cutover autorizado.** O fallback local legado → Nest → legado e backup/restore da fixture foram ensaiados; não houve reversão de Prisma nem restore de produção. O servidor padrão segue legado. Este documento não autoriza publicação ou execução em produção; eventual template VPS futuro não muda essa condição.

## O que está comprovado

- `src/server.ts` inicia o host legado. `src/main.ts` inicia o nativo somente com `NEST_BOOTSTRAP=1`; ambos usam Fastify e, por padrão, loopback:4500. `package.json` start usa `--env-file=.env`; não o use para os ensaios isolados.
- Build/typecheck/testes aprovados conforme [ADR](adr/ADR-001-nest-prisma.md); runtime compilado observado iniciando em cerca de 43 s. Configure margem de readiness de pelo menos 120 s, sem tratar demora como prova de falha nem como healthcheck.
- Testes isolados aprovados para auth, senha/PKCE, WebSocket, assets e logout LOCAL. O fluxo federado foi dispensado pelo usuário; isso não demonstra que wildcard jamais funcione em produção.
- Build Docker offline falhou por ausência de índices apt; tentativa posterior com rede normal e CA corporativa via BuildKit secret passou para HEAD `4174814e70242ba46318c1288af3314b0d111c70`, imagem `radar-nest-migration:ops-check`, ID `sha256:72809622fd63df84aabe48899191168cb4c87d6d6d6acb993794a0ae90ecdb07` (~2m20s). TLS não foi desabilitado. Runtime nativo na imagem passou internamente; acesso do host não passou. Detalhes e limites abaixo.
- A prova comparativa browser green/green + controle negativo foi autorizada como alternativa explícita ao gate genérico; passou localmente conforme a matriz abaixo. Não equivale ao `auto-test-front` literal nem aprova produção. PKCE/WS prévios foram reutilizados, não repetidos nesta comparação; logout federado foi dispensado, não aprovado.
- Fallback local em 16/10/2026: build backend aprovado; legado → Nest → legado em `127.0.0.1:45450`, com `/login` 200, `/api/me` 401 e `/busca` 302 nas três fases. Cada processo encerrou por SIGTERM com código 0 e liberou a porta; contagens sources/users/lots permaneceram 54/0/0. Evidência local: `/tmp/opencode/rollback4-execution.log`. O ensaio não cobre sessão persistida, revisão histórica, rollback de dados ou backup.

## Evidência Docker (fixture, sem cutover)

| Verificação | Comando/resultado | Limite |
|---|---|---|
| Build runtime HEAD | `docker build --pull=false --target runtime -t radar-nest-migration:ops-check --label org.opencontainers.image.revision=<HEAD> --secret id=corporate_ca,src=<CA local> .` passou; CA legível, downloads apt/npm normais; TLS verificado. | Build de worker, imagem TLS e comportamento antibot não testados. Avisos audit npm não foram corrigidos neste gate. |
| Runtime nativo interno | Container próprio `--network host`, fixture allowlist, `NEST_BOOTSTRAP=1`, `BIND_HOST=127.0.0.1`, `PORT=45461`, comando `node dist/src/main.js`. `docker exec <container> node --input-type=module -e '<fetch loopback com timeout e redirect manual>'`: `/api/security-config` 200; `/login` 200 HTML; `/api/me` 401; `/busca` 302 para login. SIGTERM/exit 0 e porta livre após remoção. | Prova somente native entrypoint override e HTTP dentro do container; imagem default continua `CMD node dist/src/server.js` (legacy). Não prova acesso host/prod nem cutover. |
| Host / namespace | Host curl às mesmas rotas retornou connection refused. Docker context `default`, endpoint unix socket; daemon reporta `Docker Desktop (containerized)`, `docker-desktop`. | Compatível com loopback/namespace distintos, mas não determina causa além do sucesso HTTP interno. Nenhuma alteração daemon/túnel/publicação. |
| Backup/restore fixture | `pg_dump -Fc --no-owner --no-privileges` da fixture, dump `/tmp/opencode/restore4-source.dump` mode 0600, SHA-256 `d49f3e6ae327b8bbbad8f6b3f20bc96fd8c33cf16a02d624523757c6d60e71ab`; restaurado em scratch exclusivo e removido após comparação. 16 tabelas; schema normalizado e contagens iguais. Origem antes/depois: sources/users/lots 54/0/0. | Prova local da fixture somente; sem hash por linha, PITR, backup ou DR de produção. Não implica implantação/autorização de cutover. |

Comandos e env foram sanitizados; segredos não devem ser copiados para logs/documentação. Evidência transitória: `/tmp/opencode/docker4-internal-routes.jsonl`, `/tmp/opencode/docker4-internal-image.txt`, `/tmp/opencode/docker4-internal-env.txt`, `/tmp/opencode/docker4-internal.log`; bootstrap instrumentado em `/tmp/opencode/docker4-probe-capture.log`. Histórico da primeira tentativa offline e dos smokes sem HTTP permanece em `.slim/deepwork/nest-prisma-migration/docker4.md`, não constitui aprovação adicional. A comparação browser green/green + negative control passou localmente (tabela abaixo); logout federado dispensado, não comprovado. Fallback local provou somente entrypoint/retorno no mesmo HEAD, não rollback Prisma histórico.

## Browser parity e aceite local (fixture)

| Execução | Resultado |
|---|---|
| Baseline `405a219` | PASS, exit 0, duração total ~2.889 s. |
| Candidate `4174814` | PASS, exit 0, duração total ~73.992 s (tempo total do harness, não startup). |
| Negative control | Intercept `/api/me` → 401; assert admin esperava 200 e falhou como esperado. Restaurada rota sem intercept: mesmo assert passou; sentinela permaneceu igual. |
| Fluxos/fixture | Busca `#q/#pb-tipo/uf/preco`; login POST 302→`/busca`; `/api/me` 200/admin; CSS/JS 200, zero page errors; logout local invalidou sessão (`/api/me` 401) e guard redirecionou login. IDs 69/70 removidos por critérios qualificados; counters 54/0/0 por execução; processos exit 0, porta livre. |

Harness `/tmp/opencode/ops4-parity.mjs`; logs `/tmp/opencode/ops4-parity-baseline3.execution.log` e `ops4-parity-candidate.execution.log`. A tentativa anterior com expectativa de status diferente para POST login 302 foi corrigida; aceite refere-se aos logs revisados acima. Isso fecha aceite local de runtime/browser/fallback, sujeito à revisão do parent, mas **não** cutover/entrega global.

## Coleta CLI isolada

O entrypoint real `scripts/collect.ts` foi executado com preload de um conector sintético no registry, banco scratch e Redis próprios, sem leiloeiro externo. Saída e persistência aprovadas: **lidos=3, mapeados=2, gravados=2, descartados=1**, dois lotes e run `ok=true`, `upserted=2`, `finished_at` preenchido; processo exit 0. `descartados` corresponde a `CollectResult.skipped`, não a rejeições adicionais do upsert. O worker BullMQ real via helper `executeWorkerCollect` e ownership token em PostgreSQL scratch também passou: exit `0`, signal `null`, mesma contagem e persistência de dois lotes/run concluído; filas e clientes foram encerrados, sem remover filas de terceiros. Uma execução anterior excedeu 120 s e não é contada como sucesso; somente o rerun com lifecycle corrigido conta.

Scratch e Redis próprios removidos; portas 56381/56382 livres e origem sources/users/lots preservada em 54/0/0. Apontamentos locais não versionados: `.slim/deepwork/nest-prisma-migration/cli5-counts.md` e `worker5-counts.md`; logs CLI `/tmp/opencode/phase5-cli-supervisor.execution.log`, `/tmp/opencode/phase5-cli-execution.log`; worker `/tmp/opencode/phase5-worker-run.log`. M5.1 concluído localmente para CLI e executor/helper do worker.

Prova M5.2 do hub real em Redis/DB scratch próprios: `/tmp/opencode/phase5-hub-proof-fixed.execution.log` (exit natural 0, signal null). Schedulers: collect `collect-soleon`, refresh/discover zero, daily 158 (120 required), catchup zero. Worker privado regular e daily manual concluíram; contagens regular `3/2/2/1`, daily `2/1/1/1`, runs/attempt persistidos e filtro de tenant deixou somente o lote do domínio aprovado. `hub.stop()` resolveu; após fechar clientes conhecidos e aguardar 500 ms, CLIENT LIST tinha somente inspector e residual vazio. Recursos próprios removidos; fixture original 54/0/0. O shutdown real expôs ownership de conexões Redis worker/publisher não fechado pelo hub; a correção cirúrgica foi validada por teste lifecycle durável abaixo. Filas globais não foram fechadas pelo hub. Limites desta execução: refresh/discover/closure desabilitados; nenhuma coleta upstream, SMTP/VAPID real ou performance de produção. Imagem Docker runtime é anterior à correção do worker e está stale para worker-only; evidência HTTP não é afetada.

Teste lifecycle durável opt-in: `test/integration/queue/worker-hub-lifecycle.test.mjs`, comando `WORKER_HUB_LIFECYCLE=1 DATABASE_URL=<OWNscratch> REDIS_URL=<OWNprivate> node --test test/integration/queue/worker-hub-lifecycle.test.mjs` (requer build backend). PASS 1/1, skip 0, exit natural 0/signal null, ~27.5 s; log `/tmp/opencode/phase5-lifecycle-durable.execution.log`. Default skip sem rede; recursos exclusivos removidos depois, original 54/0/0.

Prova independente de notifications em 16/10/2026: `NotificationService`, `PostCollectionService`, repository, matching e `marcarNotificado` reais executados sobre PostgreSQL scratch. Primeira chamada: um hit, push fake, SMTP fake e uma publicação; repetição sem novos efeitos, canais push/email marcados. Exit 0 (~9,7 s), sem transporte externo. Evidência em `.slim/deepwork/nest-prisma-migration/notifications5.md`, log `/tmp/opencode/phase5-notifications-proof.execution.log`. M5.3 localmente validado para matching/idempotência fake ports e registro de 158 schedulers daily no hub; prova hub incluiu job daily manual, não execução de todos os cron/auxiliares. SMTP/VAPID externo continua não testado.

## Ensaio local (somente fixture)

Use exclusivamente os serviços e valores descartáveis documentados em [validation-environment](validation-environment.md), nunca `.env` ou credenciais de produção. Verifique o Keycloak existente com `node scripts/test-environment.mjs check`, em `127.0.0.1:58081`; o script não gerencia PostgreSQL/Redis. Prepare estes serviços isolados conforme ambiente de validação antes de subir o backend. Não carregue `.env`.

Antes de iniciar, confirme que a porta não pertence a terceiro/processo existente:

```sh
ss -ltnp '( sport = :45450 )'
```

Se houver listener, pare: não o mate nem reutilize a porta. Para evitar importar `.env`, passe a allowlist explicitamente ao processo; em shell POSIX, defina cada variável conforme o fixture e rode:

```sh
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test BIND_HOST=127.0.0.1 PORT=45450 SITE_URL=http://127.0.0.1:45450 \
  DATABASE_URL='postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma' \
  REDIS_URL='redis://127.0.0.1:56380' \
  OIDC_ISSUER='http://127.0.0.1:58081/realms/radar-migration-test' \
  OIDC_CLIENT_ID=radar-test-web OIDC_CLIENT_SECRET=radar-test-client-secret \
  OIDC_ROLE_ADMIN=radar-admin APP_SESSAO_SEGREDO=radar-migration-fixture-cookie-secret-not-for-production \
  ANTIBOT_MODE=off ANTIBOT_CHALLENGE_MODE=off \
  node --import tsx src/server.ts
```

Compare legado com o nativo encerrando o primeiro processo e confirmando a porta livre antes de iniciar o segundo; mantenha a mesma allowlist e acrescente `NEST_BOOTSTRAP=1`, substituindo o entrypoint por `src/main.ts`. Aguarde até 120 s; `/api/security-config` 200 sinaliza prontidão HTTP, não aceite operacional completo. `/health` exige autenticação administrativa. Encerre com SIGTERM e confirme saída e porta livre. Para voltar ao legado, troque o entrypoint para `src/server.ts`: retirar a flag de `main.ts` não inicia o legado. Para artefatos compilados, use respectivamente `node dist/src/main.js` e `node dist/src/server.js`, sem `--import tsx`. Não exponha serviços.

## Cutover/rollback — template futuro, não executar

Somente após gates e aprovação operacional: guardar tag/revisão anterior e artefato imutável; guardar backup de configuração/env em cofre autorizado, nunca no Git; validar restore em ambiente separado. Planejar janela, drenagem de tráfego e conexões WebSocket, parar worker/CLI de forma coordenada e impedir duplicação de ingestão. `src/server.ts` fecha Fastify/TLS em SIGTERM; confirmar lifecycle dos workers separadamente antes de assumir drenagem completa.

Canário e readiness devem observar status HTTP conforme contratos existentes, auth/OIDC, erros e latência, WebSocket, assets/SSR, recursos/DB e logs. Healthcheck da imagem web usa `/` e não substitui esses gates. Não declarar rollback por simples healthcheck verde.

Rollback de aplicação: retornar à revisão/tag anterior e ao entrypoint legado (`src/server.ts`, sem `NEST_BOOTSTRAP=1`), após drenar conexões e workers; manter shims de compatibilidade até aceite formal. Não reverter esquema automaticamente: somente migrations aditivas compatíveis entre versões. Se houver incompatibilidade de dados, parar escrita e restaurar backup apenas em manutenção autorizada e com plano validado. Nunca usar `prisma reset`, `drop` ou `down` contra dados.

## Go/no-go e limites

**No-go para cutover/entrega global.** M3.5 e M5.1 aprovados localmente nos limites registrados; M5.2 hub real/worker privado/schedulers/shutdown e teste lifecycle durável aprovados localmente; M5.3 matching/idempotência fake ports e registro daily aprovados localmente, sem SMTP/VAPID real nem cobertura integral de cron/auxiliares. M6.1/M6.2 provas locais aprovadas nos recortes executados; rollback histórico/PITR/DR produção/canário não aprovados. M4.5 cutover, M6.3 remoção do legado e M6.4 entrega global permanecem pendentes por decisão do usuário. Sem implantação. Ingress HTTPS/WebSocket e autorização operacional pendentes; runtime image é stale para worker-only e não se reivindica novo build de imagem worker. Manter legado/shims; avaliar TLS legado em `PORT+1` versus terminador efetivo.

Comparar p50/p95, taxa de erro, auth, sessões, conexões WebSocket, falhas de worker e contagens de coleta (`lidos/mapeados/gravados/descartados`); investigar antes de avançar. Locks Redis atuais têm limite TOCTOU/fencing: não presumir exclusão forte entre workers nem aumentar concorrência sem provar ownership/cancelamento compartilhados.

Referências: [ADR-001](adr/ADR-001-nest-prisma.md), [PRD](prd/PRD-nest-prisma.md), [ambiente de validação](validation-environment.md), `package.json`, `src/main.ts`, `src/server.ts`, `Dockerfile` e `docker-compose.production.yml`. Compose de produção é template; não executar nesta máquina.
