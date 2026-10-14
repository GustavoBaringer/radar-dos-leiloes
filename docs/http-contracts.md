# Contratos HTTP legados — baseline para a migração

Escopo observado em `src/legacy-host.ts` e plugins importados, antes de migrar HTTP. Esta é a matriz completa das rotas explícitas do host (inclui rota opcional de brands e ramos de configuração); Fastify também pode responder `HEAD` automaticamente para `GET`, e o plugin `@fastify/static` atende arquivos sob os prefixos configurados. Os contratos exatos dependem do ramo OIDC/portão, existência do build SPA, papel e hooks descritos abaixo. Preservar respostas, efeitos e precedência dos hooks; não ampliar escopo do produto.

**Convenções de acesso:** `Público` é acesso sem sessão permitido pelo portão OIDC, não bypass de segurança; `Conta` exige sessão OIDC quando ligado, mas em dev sem OIDC o hook não existe; `Admin` requer papel admin (sem OIDC `papelDe` considera admin); `Livre/auth` identifica endpoints que implementam login/logout. `R` pode receber `401` por admission account/portão. `?` representa query string; body usa parser JSON Fastify e `@fastify/formbody` (limite global 16 KiB, `src/legacy-host.ts:95-99,266`). Resposta não detalhada para cada 5xx: handler global converte a `{erro:"erro interno"}` ou página HTML genérica conforme Accept, sem expor detalhe do banco (`:185-200`).

## Rotas e contratos

| Método e rota | Acesso | Entrada (query/body/path) | Resposta/status e erros relevantes | Efeitos / proprietário atual |
|---|---|---|---|---|
| `GET /login` | Livre/auth | `?de` destino interno | HTML de login; se portão desligado redireciona 302 a `/busca` e limpa `radar_saiu` | OIDC/portão; `legacy-host.ts:446-448,622-624` |
| `GET /auth/login` | Livre/auth | `?de` | OIDC off: 404 `{erro}`; sucesso 302 IdP e cookie PKCE; falha do IdP: 502 HTML | Inicia OIDC/PKCE, Redis/Keycloak; `:467-484` |
| `GET /auth/callback` | Livre/auth | `code`, `state`, `error`; cookie PKCE | cancelamento: 400 HTML; sucesso 302 para destino seguro + cookies; falha: 400 HTML; OIDC off: 404 | Valida PKCE, upsert usuário/role; `:486-515`, `core/identidade.ts:35-53` |
| `GET /auth/logout` | Livre/auth | cookies de sessão/OIDC | 302; limpa cookie local e opcionalmente encerra IdP | Logout OIDC/portão; `:522-536`; ramo sem OIDC `:627-632` |
| `POST /api/login` | Livre/auth | JSON ou form `usuario`, `senha`, `de` | sucesso 302; inválida 401 HTML; rate limit 429 HTML; provedor indisponível 502; mensagens genéricas | Keycloak senha, Redis contador 8/15min e upsert user; `:538-617` |
| `GET /` | Público | — | HTML `landing-antibot.html`, `no-cache` | SSR/página versionada; `:736`, `:697-730` |
| `GET /busca`, `/alertas`, `/favoritos`, `/cobertura` | Conta (livre no dev) | — | Casca SPA HTML `no-cache`; sem build: 503 texto | SPA/client build; `:689-747` |
| `GET /lote/:slug` | Conta; crawler social GET pode ser anônimo | slug | SSR do lote/casca `private,no-store`; inválido/não encontrado: 302 `/busca`; slug não canônico: 404 `{erro}`; build ausente: 503 | DB, contexto de conta/favorito, SSR React, OG/JSON-LD; `:762-894` |
| `GET /robots.txt` | Público | — | text/plain robots com allow `/api/img`, demais API bloqueadas | SEO; `:900-920` |
| `GET /sitemap.xml` | Público | — | XML com rotas públicas não-API | SEO; `:922-936` |
| `GET /api/home` | Conta | sem query | `{recentes,leiloeiros,fontes,total,totalLeiloeiros,ufs}`; cards decorados por conta | SQL leitura de lots/auctioneers; `:960-992` |
| `GET /api/vitrine` | Público | sem filtros ou paginação | agregado/categorias/UF/leiloeiros, até 8 lotes + heroes/encerrando/porHora | Acesso público limitado, consultas somente leitura; `:1001-1119` |
| `POST /api/espera` | Público | body `{email,nome?,interesse?,consentimento}` | 200 `{ok:true}` inclusive duplicado; 400 `{erro}` | INSERT `espera`, consentimento; `:1121-1146` |
| `POST /api/cadastro` | Público | body nome/documento/email/celular/consentimento/consentimentoVersao/marketing/origem | sucesso 201 `{ok,proximoPasso,mensagem}` anti-enumeração; 400 `{erro,campo}`; 429 | INSERT cadastro, rate limit Redis quando anti-bot não enforce; sem integração de pagamento neste handler; `:1148-1216` |
| `GET /api/home/leiloeiro` | Conta | `?nome` string obrigatória | array até 24 cards; query inválida: 400 `{error|erro}` | SELECT lots + contexto conta; `:1218-1233` |
| `GET /api/search` | Conta | query conforme `parseSearchInput`/`request-bounds` | objeto de busca `{total,page,pageSize,interpreted,items,facets}`; erros limitados pelo handler global | searchLots e decoração por usuário; `:1235-1239`, `core/repo.ts:238-285,492` |
| `GET /api/malha/:tipo` | Conta | `tipo=uf\|municipio` | JSON do arquivo local; tipo/arquivo ausente 404 `{error}`; `municipio` ~2.3 MB | leitura `dataDir/geo`; `:1241-1252` |
| `GET /api/search/mapa` | Conta | mesma query de busca | `RespostaMapa` (`pontos,total,semLocalizacao,soCidade,semNada,truncated,omitted*`) | SQL mapa com mesmo filtro; `:1254`, `repo.ts:765+` |
| `GET /api/lot/:id` | Conta | `id` positivo | lote público decorado; id inválido 400 `{error}`; ausente 404 | SQL detalhe; admin recebe dados internos; `:1256-1264` |
| `GET /api/me` | Conta (resolve visitante anônimo em rotas públicas/dev) | cookie | payload `buildMePayload` com papel, OIDC, logado, conta e contagens | consulta identidade/resumo; `:1277-1294` |
| `GET /api/stats` | Admin | — | `getStats()`; não-admin 403 `{erro:"requer administrador"}` | leitura stats; `:1301-1307` |
| `GET /api/alerts` | Conta | `page,pageSize` | paginação `{items,total,...}` de alertas do dono | somente leitura filtrada owner_id; `:1311-1324` |
| `POST /api/alerts` | Conta | `ValidateAlertInput`: label/q/filters/channels/email | alert DTO, contagens `casados_agora:0,no_indice_agora`; validação conforme erro do handler | INSERT alerta; jamais cria hits de lotes passados; `:1326-1351` |
| `PATCH /api/alerts/:id` | Conta/dono | id positivo; input parcial edit | alert DTO; id inválido 400, não do dono/inexistente 404 | UPDATE owner_id no WHERE; `:1353-1369` |
| `DELETE /api/alerts/:id` | Conta/dono | id positivo | `{ok:true}`; inválido 400, ausente/alheio 404 | DELETE filtrado por dono; `:1371-1384` |
| `GET /api/alerts/hits` | Conta | `naoVistos,page,pageSize,alertId`; chaves extras inválidas | paginação de hits agrupados por lote e decorados; bounded input errors | leitura sem apagar hits; encerra/vencido é filtrado; `:1386-1438` |
| `POST /api/alerts/hits/seen` | Conta | body opcional `{alertId?}` | `{ok:true}`; entrada inválida gera bounded error | UPDATE hits não vistos dos alertas do dono; `:1440-1451` |
| `GET /api/favorites` | Conta | `page,pageSize` | paginação cards favoritos ativos | leitura; lote encerrado/vencido some, vínculo preservado; `:1455-1484` |
| `POST /api/favorites` | Conta | body estrito `{lotId:number}` | `{ok:true}`; corpo/id inválido 400 | INSERT idempotente owner+lot; `:1486-1497` |
| `DELETE /api/favorites/:lotId` | Conta | id positivo | `{ok:true}`; id inválido 400 | DELETE filtrado por owner; `:1499-1505` |
| `GET /api/push/key` | Público/route policy `search` | — | `{publicKey:string|null}`; admission account quando regra estiver ativa | leitura env; `:1509`; `routes.ts:44-45` |
| `GET /ca.crt` | Livre | — | CA download `application/x-x509-ca-cert`; não existe 404 `{erro}` | leitura arquivo local; `:1511-1524` |
| `POST /api/push/subscribe` | Conta | body push endpoint HTTPS + keys p256dh/auth + expirationTime opcional | `{ok:true}`; payload/URL inválidos 400 `{erro}` | upsert `push_subscriptions`, owner_id; `:1526-1547` |
| `GET /api/notificacoes/status` | Conta | — | `{canais,publicKey,dispositivos}` `Cache-Control:no-store` | leitura subscriptions do dono; `:1549-1571` |
| `GET /api/img` | Público | `u` URL permitida, `w` dígitos opcional | imagem + `content-type`, cache/x-cache; erro de input 400 JSON; overload/upstream 503; falha comum SVG nopic 200 | proxy HTTPS allowlist, sharp/cache, abort e telemetria; `:1573-1752` |
| `GET /api/sources` | Admin | — | array de sources + contagens/última coleta; não admin 403 | leitura; `:1754-1761` |
| `GET /api/brands` | Conta | — | `{known: string[], present: [{brand,count}]}` conforme `brands.dto.ts`; registrado somente se `excludeLegacyBrands=false`; 404 se piloto Nest substitui | consulta SQL brands, `modules/catalogo/adapters/http/brands.legacy.ts:1-13`; `legacy-host.ts:1763-1766` |
| `GET /api/explain` | Conta | query `q` | resultado de `parseQuery(q)`; não é explicação SQL | parse puro; `:1767-1771` |
| `POST /api/collect` | Admin | body `{sourceId?,limit?}` | `{enfileirado:[{sourceId,jobId}]}`; fonte desconhecida 400 com fontes válidas; admin check 403 | enfileira BullMQ `collect:manual`; `:1773-1790` |
| `GET /ws` (upgrade WebSocket) | Conta; cookie válido e admission | handshake; payload máximo 64 KiB | handshake negado com 401/429/503 JSON; conectado recebe `{type:"hello",ts}` e eventos filtrados | Redis pub/sub; mensagem alerta só ao dono e sem PII; collect/encerrados só admin; lance broadcast; reservation/admission; `:1792-1849`, `core/antibot/ws-admission.ts:18-68` |

### Plugins, métodos implícitos e páginas/arquivos

| Superfície | Métodos/rota | Acesso, contrato e efeito | Dono atual |
|---|---|---|---|
| Challenge | `GET /api/security-config`; `GET /challenge.js`, `/challenge.css`, `/landing-antibot.js`, `/landing-antibot.html` | GET; config JSON `Cache-Control:no-store`, assets via `sendFile`; público/livre; hook `createChallengeHook` aplica verificação conforme modo/policy. `HEAD` para GET é policy explicitada, mas plugin não registra handler HEAD separado. | `core/antibot/routes.ts:4-14,66-83`; registrado `legacy-host.ts:237` |
| Métricas operations | `GET /api/security/metrics` | Admin autenticado: snapshot telemetry; sem id: 401 `{error:unauthorized}`; papel não admin: 403 `{error:forbidden}`; no-store. HEAD listado na policy, sem handler explícito. | `core/antibot/routes.ts:15-16,85-96`; `legacy-host.ts:257` |
| Rate policy | HEAD policy para endpoints GET listados em `ROUTE_POLICIES` | `@fastify/rate-limit`, hooks `onRequest` IP e `preHandler` account; 429 `{error:rate_limited,retryAfterSeconds}` + Retry-After/no-store. Hooks opcionais por modo e policy configurada. | `core/antibot/routes.ts:4-63`; `core/antibot/fastify.ts:83-160`; hooks `legacy-host.ts:259-267` |
| Static web | `GET/HEAD /<arquivo>` prefix `/`, web root; `GET/HEAD /assets/*` do client SPA (quando build existe) | Arquivos servidos pelo `@fastify/static`; `assets` público no gate e cache imutável 1y; arquivos web são públicos quando listados em `PUBLICAS`, o restante segue auth gate; métodos GET/HEAD do plugin. | `legacy-host.ts:314-345,635-659`; web assets em `web/` |
| Serviço worker e recursos | `GET /sw.js`, `/nopic.svg`, `/nopic-imovel.svg`, `/login-hero.jpg`, `/mapa-lotes.jpg`, JS/CSS do landing/cartão/slug | Arquivos estaticamente servidos por `/`; livres/públicos conforme `LIVRES`/`PUBLICAS`; não são handlers `app.get` individuais. | `legacy-host.ts:302-338,635-659` |
| Request genérico | `HEAD` GETs; 404 e erros não capturados | GET HTML não-API desconhecido recebe HTML 404; API/Accept restante JSON `{erro,rota}`. Exceção 4xx conserva mensagem; 5xx genérico e log interno. Headers de segurança e política no-send em resposta. | `legacy-host.ts:185-232`; static e Fastify |

### Segurança/transporte obrigatório a preservar

- Um Fastify listener; Nest piloto usa `FastifyAdapter`, `bodyParser:false`, filtro global delegado ao error handler legado e adapter impede Nest de trocar handlers globais (`src/legacy-nest-host-brands.ts:8-50,63-92`). Não registrar rota duplicada.
- OIDC ligado: rotas `LIVRES`, rotas públicas e arquivos têm exceções explícitas; demais API/WS sem sessão retornam 401 e navegação 302 `/login?de=...`; crawlers sociais têm exceção GET `/lote/*`. Sessões são cookie assinado, renovação deslizante e papel vindo do token/identity (`legacy-host.ts:302-421`; `core/auth.ts`).
- Headers CSP, `nosniff`, `x-frame-options`, referrer-policy e `no-store` em rotas sensíveis são transversais (`legacy-host.ts:203-232`). `registerAntibot` hook order: rate IP antes de auth e account depois; preservar policies e códigos (`core/antibot/fastify.ts:131-157`).
- WebSocket é protocolo nativo em `@fastify/websocket`, não Socket.IO. Admission valida sessão/abuso e reservation Redis, attach/release no upgrade e filtros de entrega no servidor (`legacy-host.ts:1792-1849`; `core/antibot/ws-admission.ts`).

## Implementação Nest aditiva validada (fase 4)

O backend Nest tem runtime opt-in via `NEST_BOOTSTRAP=1`/`createRadarApplication`; o servidor padrão (`src/server.ts`) continua legado. O inventário estático de métodos/caminhos identifica 43 rotas de negócio (incluindo WS), dois helpers de segurança por lado e um health novo; conta 49 rotas antigas (inclui quatro assets explícitos de challenge) e 46 novas (assets via wildcard). HEAD automático e nomes de parâmetros são normalizados no inventário. Testes HTTP exercitam grupos de contratos, sem comprovar comparação runtime exaustiva rota a rota dessas 43 rotas. `GET /api/brands` é atendido pelo `CatalogController` nativo; não registrar também o módulo piloto de brands. `configurePageAssets` monta apenas `/assets/` do client compilado; `configureHttpPlatform` serve os arquivos estáticos da raiz web e `PagesService` atende SSR. Foi validado acesso anônimo e cache imutável de 31.536.000s para assets com hash.

Auth nativa foi validada com senha Keycloak e callback HTTP PKCE (não browser UI), issuer/`session_state` não vazios, JWKS e leitura de identidade no PostgreSQL. Metadata opcional do callback tem strings limitadas; JWKS continua usando configuração confiável, sem URL de metadata do IdP. Política existente de conta continua produzindo 401/403 onde aplicável; `/api/vitrine` mantém acesso público limitado; páginas e recursos públicos seguem a matriz, sitemap só landing pública. Imagens têm testes de upstream ausente/503 e falha degradada. WebSocket permanece nativo, com testes de auth/hello, privacidade owner/admin e cleanup. Browser smoke e cutover não estão cobertos/concluídos.

## Destino proposto para etapas ainda não migradas

| Grupo de contrato | Controller sugerido | Service sugerido | Owner explícito |
|---|---|---|---|
| Catálogo, busca, home, vitrine, mapa, lote, brands, sources | `src/application/controllers/catalog.controller.ts` | `src/application/services/catalog.service.ts` | Lane de catálogo |
| Conta, `me`, alerts/hits, favorites, push, notificações | `src/application/controllers/accounts.controller.ts` | `src/application/services/accounts.service.ts` | Lane de contas |
| Login, OIDC callback/logout, páginas, SSR/robots/sitemap | `src/application/controllers/auth.controller.ts`, `pages.controller.ts` | `auth.service.ts`, `pages.service.ts` | Lane auth/pages |
| Challenge/config, metrics/admin, anti-bot admission, image proxy | `src/application/controllers/security.controller.ts`, `media.controller.ts` | `security.service.ts`, `media.service.ts` | Lane security/media |
| WebSocket, lifecycle, static/assets, Fastify hooks/error/header | preservar Fastify plugin/adapters; sem controller fake HTTP | `src/application/services/realtime.service.ts` só para regra/coordenação; transporte continua nativo | Lane platform/hooks |
| coleta manual admin | catalog/ops controller, rota mantida | `src/application/services/collection-admin.service.ts` | Lane workers/ops; fila é I/O |

Não mover frontend/SSR e WebSocket para controllers se quebrar `FastifyAdapter`, compatibilidade de header/cache, upgrade ou build compilado. Classes controller/service têm dono explícito; interfaces somente para fronteiras de I/O.

## Efeito de versão e gaps conhecidos

- `GET /api/brands` é a única rota experimentalmente oferecida ao Nest piloto; piloto está fora de `server.ts`, exclui a rota legada somente quando chamado e não representa migração HTTP concluída (`legacy-nest-host-brands.ts:63-92`).
- GET e HEAD policy em `ROUTE_POLICIES` não significa todos os métodos presentes na aplicação: o registro explícito usa GET nos endpoints anotados; `HEAD` pode vir do Fastify/plugin. Migrar sem criar body em HEAD e testar `Content-Length`/status.
- Sem build `app-busca`, rotas SPA/detalhe retornam 503, não fallback arbitrário. O redirect/SSR deve manter slug canônico e ocultação de campos internos.
- `GET /api/search` e demais APIs classificadas account exigem sessão OIDC em modo OIDC, mesmo que o UI/rota seja navegável. `/api/vitrine` é endpoint aberto limitado, não autorização de busca pública.
