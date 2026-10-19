# PRD — Reimplementação NestJS + Prisma

- **Estado:** planejamento aprovado; implementação em andamento, não concluída.
- **Base:** `405a219`; data: 2026-10-14.
- **Decisão relacionada:** [ADR-001](../adr/ADR-001-nest-prisma.md).

## Problema e objetivo

Migrar a aplicação backend existente para NestJS com Prisma sem alterar experiência, regras de negócio, segurança nem operação. Substituição progressiva, com prova observável de equivalência antes de retirar cada caminho legado.

## Usuários e escopo

Usuários HTTP existentes e operadores dos conectores, CLI, workers e serviços operacionais. Inclui reimplementação autorizada em `src/application/{controllers,services,modules}`, domínio com entidades/políticas/validadores puros, persistência Prisma 7/PostgreSQL e integrações de I/O existentes. Inclui Swagger, class-validator, classes TypeScript, Jest e Supertest.

Preservar FastifyAdapter, Node 24, ESM e build compilado; PostgreSQL, Redis, BullMQ e Keycloak; parsers, conectores, SQL especializado, WebSocket nativo, SSR, assets, streaming e anti-bot. A aplicação continua servindo contratos HTTP existentes (cerca de 40 rotas), sem redesenho, categorias novas ou mudança de produto.

## Fora de escopo

Reorganização visual/UX, alteração de regras ou taxonomia de bens, migração para Express/Socket.IO, microsserviços, generic repository/CQRS, troca de provedores, remoção prematura do legado, mudança de contratos públicos e operações em produção sem autorização. Não instalar ou iniciar túneis; não expor host local à internet.

## Requisitos funcionais

1. Cada rota migrada mantém método, URL, status, envelope, filtros, paginação, erros, autenticação/autorização e semântica de cookies/header; regressões verificáveis por comparação legado/Nest.
2. Preservar PKCE/OIDC, cookie assinado, papéis, sessão, anti-bot, rate limits, streaming de imagem, SSR/assets e protocolo WebSocket atual.
3. Centralizar regras de domínio preservando o comportamento observado em `src/core/repo.ts:75-89`: publica imóveis e veículos; classifica como `outro` e não insere/reabre esse lote. Embora o guia mencione máquinas/equipamentos, isso não autoriza ampliar o escopo atual durante a migração. Preservar também rejeição anti-colecionáveis, normalização/mascaramento, histórico de lance, relistagem, encerramento, `fim=NULL` e segunda praça.
4. Toda escrita de lote e histórico que hoje é atômica continua transacional no PostgreSQL. Separadamente, preservar validação de origem/domínio e os mecanismos existentes de lock/autorização/cancelamento da coleta; não presumir lock de tenant no PostgreSQL.
5. CLI e cada worker compartilham executor de coleta e as mesmas políticas de persistência, sem bifurcação de regra.
6. Prisma 7 versionado, schema e migrations reconciliados com os 16 SQLs. Baseline de banco vazio reproduz o schema integral; marcar como aplicada somente em clone cuja equivalência tenha sido verificada.
7. DTOs HTTP validam entradas na fronteira; Swagger descreve contratos sem alterá-los.

## Requisitos não funcionais

- Regressão zero de segurança e contratos; transações/locks sem enfraquecimento.
- Node 24, ESM e build de produção compilado continuam funcionais.
- Testes determinísticos offline quando apropriado e integração em PostgreSQL/Redis isolados; nenhum teste escreve em produção.
- Execução e validação somente em loopback; nenhuma instalação/conexão de túnel ou publicação.
- Logs e métricas suficientes para comparar erro, latência, ingestão e integridade durante canário.

## Critérios de aceite / evidências requeridas

| Gate | Evidência para aceite |
|---|---|
| Typecheck | `npm run typecheck` passa no commit candidato. |
| Build | `npm run build:backend` e inicialização do build compilado passam em ambiente isolado. |
| Regressões | Jest para regras/domínio e contratos; testes existentes relevantes passam. |
| Integração PostgreSQL | Banco descartável real; migrations do vazio, constraints, SQL especial, transações, histórico e relistagem comprovados. |
| HTTP | Supertest cobre todas as rotas/métodos migrados, auth/papéis, erros, limites e compatibilidade de resposta. |
| WebSocket/segurança | Testes do protocolo nativo, admission, anti-bot, cookies/PKCE e streaming; regressões existentes aprovadas. |
| Front smoke | SSR/assets e fluxos de frontend essenciais em host local, sem publicar/expor a aplicação. |
| Coleta | CLI e workers exercitam executor compartilhado e relatório `lidos/mapeados/gravados/descartados`; validar tenants/locks em ambiente seguro. |
| Schema | Comparação automatizada/registrada de schema vazio e clone; baseline não marcado em outro banco. |
| Entrega | Cutover e rollback ensaiados, sem escrita de produção durante esta migração. |

## Indicadores

- 100% das rotas inventariadas com proprietário, contrato e estado; 100% migradas e cobertas antes de retirar legado.
- Zero diferença não aprovada nos contratos e permissões; zero perda/corrupção em integração de escrita.
- 100% das migrations reconciliadas e testadas em banco vazio; duração/erros de integração reportados.
- Comparar p50/p95 e taxa de erro com baseline legado, sem regressão acordada; cobertura por métricas operacionais não substitui gates funcionais.
- Coleta informa contagens de lidos, mapeados, gravados e descartados e não degrada locks/concorrência.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Diferença de schema SQL/Prisma | Inventário de 16 scripts, diff de schema e teste de banco vazio/clone antes de baseline. |
| Contrato HTTP ou segurança divergente | Inventário de rotas e testes comparativos Supertest; migrar/cortar rota individualmente. |
| ORM alterar atomicidade, locks ou SQL particular | Prisma Client transacional e SQL especial; integração PostgreSQL real. |
| Divergência de regra de lote/coleta | Regras de domínio com regressões específicas e executor compartilhado worker/CLI. |
| Inicialização conjunta Nest/Fastify ou build ESM | Preservar adapter/compilação e validar bootstrap e build isoladamente antes de cutover. |
| Duração subestimada | Reserva explícita de 12–16 semanas e redução de escopo por prioridade, nunca por remoção de gates. |

## Estimativa

Estimativa de planejamento: **320–480 horas de engenharia com assistência de IA**; estimativa sem IA de **450–700 horas**. Calendário estimado em **10–14 semanas**, com reserva de **12–16 semanas**, conforme equipe e integrações. Incerteza alta até inventário de rotas, schema e contratos; recalibrar ao fim da fase 1. Não é compromisso de entrega.
