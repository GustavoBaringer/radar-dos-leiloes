# Backlog — migração NestJS + Prisma

Plano vinculado ao [ADR](adr/ADR-001-nest-prisma.md) e ao [PRD](prd/PRD-nest-prisma.md). Base planejada `405a219`; gates posteriores: foundation `867a92d`, domínio/persistência `7149efd` (Gate 3 aprovado). Fase 4 está implementada e validada de forma aditiva, mas o servidor padrão (`src/server.ts`) continua legado: migração/cutover final não concluído. Donos são papéis sugeridos, não atribuições pessoais.

| ID | Fase | Subtarefa | Dependência | Dono (specialist) | Aceite verificável | Status |
|---|---|---|---|---|---|---|
| M1.1 | 1 — Inventário, docs e contratos | Inventariar métodos/rotas incluindo plugins security/challenge/ops/WS, static/SSR; auth/papel, entrada, status/envelope, efeitos e owner. | — | Backend/API | Matriz escrita em [contratos HTTP](http-contracts.md), refs para handlers/plugins e parâmetros; sem alegar teste/runtime desta lane. | Concluído |
| M1.2 | 1 | Documentar OIDC/PKCE, cookie assinado, anti-bot, WebSocket, SSR/assets, erro/header/limites Fastify. | M1.1 | Segurança/backend | Contratos transversais e destino de controllers/services documentados em [contratos HTTP](http-contracts.md). Cobertura executável continua gate futuro. | Concluído |
| M1.3 | 1 | Catalogar writers de repo/alerts/identidade/descoberta/encerramento/tenant attempts, endpoints/admin, jobs/CLI e scripts one-off; separar authority/rollback. | — | Banco de dados | [Inventário de writers](writer-inventory.md) documenta SQL, guarda/transação, autoridade, rollback e lacunas conhecidas. | Concluído |
| M1.4 | 1 | Fixar contratos de domínio e executor: filtro efetivo, normalização, histórico, precisão, fim NULL/relistagem, encerramento, worker e CLI. | M1.3 | Domínio/coleta | Regras observadas e refs registradas em [inventário de writers](writer-inventory.md); testes de migração seguem pendentes. | Concluído |
| M1.5 | 1 | Registrar baseline typecheck/build/146 testes; identificar lacuna de desempenho/operação local e revisar estimativa. | M1.1–M1.4 | QA/tech lead | Baseline fornecido para este plano: typecheck, build e 146 testes Concluídos; nenhuma métrica de produção/performance foi medida ou inferida neste documento. | Concluído |
| M2.1 | 2 — Fundação Nest/Prisma/schema | Configurar módulos de aplicação e bootstrap Nest com FastifyAdapter no runtime ESM/Node 24, sem mudar cutover. | M1 | Plataforma/backend | Bootstrap compilado opt-in, health/DTO/OpenAPI aprovados; host antigo inalterado. | Concluído |
| M2.2 | 2 | Fixar Prisma 7, `prisma.config.ts`, adapter `pg` e configuração de ambiente segura. | M1.3 | Banco/Plataforma | Prisma 7.10.0 gerado no build; conexão local e transações testadas. | Concluído |
| M2.3 | 2 | Reconciliar schema Prisma com os 16 SQLs, incluindo constraints/indexes/defaults e SQL não representável. | M1.3, M2.2 | Banco de dados | Paridade de 344 entradas do catálogo; objetos especiais preservados no SQL. | Concluído |
| M2.4 | 2 | Criar migrations e baseline integral do banco vazio; provar equivalência antes de marcar clone. | M2.3 | Banco de dados | Deploy em banco vazio e baseline/deploy no clone fixture aprovados; nenhuma operação em produção. | Concluído |
| M2.5 | 2 | Configurar Jest/Supertest e helpers isolados para teste de domínio, HTTP e banco. | M2.1–M2.4 | QA | Jest unitário, HTTP Supertest e três testes PostgreSQL passaram, além de 146 regressões; gate Oracle aprovado. | Concluído |
| M3.1 | 3 — Domínio/persistência | Modelar entidades, políticas e validadores puros; classes apenas com responsabilidade concreta. | M1.4, M2.3 | Domínio | Regras puras de domínio e testes Jest em `src/domain`; evidência na fase 3 aprovada. | Concluído |
| M3.2 | 3 | Migrar persistência central para Prisma, mantendo SQL especial e transação de `upsertLots`. | M3.1, M2.4 | Persistência | `upsertPrisma` transacional: teste PostgreSQL de 15k INSERT/65.882s, UPDATE/55.469s e histórico 30k; transação única por batch; timeout 300 s; fixture limpa. | Concluído |
| M3.3 | 3 | Preservar filtragem imovel/veículo/escopo, anti-colecionáveis, mascaramento e normalização. | M3.1–M3.2 | Domínio/coleta | Regressões de domínio/persistência cobrem anti-colecionáveis, escopo e validação de placas; ver testes phase 3. | Concluído |
| M3.4 | 3 | Preservar encerramento, fim nulo, relistagem e segunda praça. | M3.2 | Domínio/banco | `upsertPrisma` preserva histórico, `fim=NULL`, encerramento e relistagem; cobertura PostgreSQL da fase 3. | Concluído |
| M3.5 | 3 | Preservar validação fonte/domínio e mecanismos existentes de lock BullMQ, autorização de persistência e cancelamento; manter transações PostgreSQL para escritas atômicas, sem presumir lock de tenant no PostgreSQL. | M3.2 | Banco/coleta/filas | **Pendente/deferido à fase 5**: lock/ownership/cancelamento com Redis real e guarda compartilhada ainda não migrados nem testados. | Pendente |
| M4.1 | 4 — HTTP, auth e plataforma | Migrar controllers/services/modules rota a rota; DTOs class-validator e Swagger compatível. | M1.1, M2.1, M2.5, M3 | API/backend | Runtime Nest opt-in e matriz backend: Jest 14 suites/67 testes, build e typecheck aprovados; rotas/controllers nativos adicionados sem cutover. | Concluído |
| M4.2 | 4 | Migrar identidade, Keycloak/OIDC/PKCE, cookies, papéis e autorização. | M1.2, M4.1 | Segurança/backend | 3 suites/16 testes: senha Keycloak e callback HTTP PKCE real; issuer, `session_state` e JWKS verificados contra PostgreSQL/cookies. Sem browser UI. | Concluído |
| M4.3 | 4 | Integrar limites/anti-bot, streaming de imagens, SSR e assets com Fastify existente. | M1.2, M4.1 | Plataforma/web | Testes cobrem SSR/assets, imagem (4), falhas/upstream e anti-bot; front smoke em browser permanece pendente na fase 6. | Em andamento |
| M4.4 | 4 | Preservar WebSocket nativo e fluxo de admission/proteção. | M1.2, M4.1 | Plataforma/segurança | 2 testes nativos cobrem auth/hello, privacidade owner/admin e cleanup. | Concluído |
| M4.5 | 4 | Fazer cutover controlado de rotas compatíveis mantendo fallback legado. | M4.1–M4.4 | Backend/QA | Default/cutover e rollback continuam pendentes; servidor padrão (`src/server.ts`) segue legado, Nest exige `NEST_BOOTSTRAP=1`. | Pendente |
| M5.1 | 5 — Workers, CLI e infraestrutura | Migrar executor de coleta para serviços compartilhados entre CLI e workers BullMQ. | M3, M2.5 | Coleta/filas | Mesmo executor e políticas usados nos dois caminhos; teste/relatório de contagens. | Pendente |
| M5.2 | 5 | Integrar Redis, filas, cancelamento, timeout, scheduler e lifecycle Nest. | M5.1, M1.2 | Plataforma/filas | Integração em Redis isolado cobre shutdown, retry, cancelamento e concorrência. | Pendente |
| M5.3 | 5 | Migrar tarefas auxiliares/cron, observabilidade e notificações sem duplicar efeitos. | M5.1–M5.2 | Coleta/infra | Teste de execução prova idempotência esperada e métricas/logs úteis. | Pendente |
| M6.1 | 6 — Provas reais, retirada e entrega | Executar matriz completa: typecheck, build, Jest, PostgreSQL real, Supertest, WS e front smoke. | M4–M5 | QA/Backend | Todos os gates do PRD com evidência anexada; falhas bloqueiam cutover. | Pendente |
| M6.2 | 6 | Validar migrations em banco vazio e clone; revisar backup/rollback/canário. | M2.4, M6.1 | Banco/Operações | Equivalência assinada, rollback ensaiado; sem escrita de produção nesta etapa. | Pendente |
| M6.3 | 6 | Remover legado apenas após cobertura/aceite de todas as rotas e fluxos. | M4.5, M5, M6.1–M6.2 | Backend/tech lead | Inventário sem rota dependente, fallback dispensável e aceite operacional registrado. | Pendente |
| M6.4 | 6 | Entrega final, documentação operacional e pós-cutover monitorado/autorizado. | M6.3 | Operações/Backend | Plano de operação/rollback, métricas e decisão formal de encerramento. | Pendente |

## Estado de evidências e gates (14/10/2026)

| Verificação | Evidência esperada | Quando |
|---|---|---|
| Backend atual | `npm run build:backend`, `npm run typecheck`; Jest 14 suites/67 testes | Fase 4 validada; resultado registrado pelo gate pai `sh_13cc70f6e001zSlSLNGjpILHAQ` |
| Regressões antigas | 146 testes passaram com o ajuste de assets, antes do ajuste final de 3 linhas da admissão de imagens nativa; caminhos/helpers legados inalterados, prova REUSED | Gate de regressão da fase 4 |
| Integração PostgreSQL real | 15k INSERT/UPDATE, histórico; transação única por batch; timeout 300 s; fixture limpa | Fase 3; evidência acima |
| Regressões Jest da migração | domínio, normalização, coleta e policies | A cada migração de regra |
| Integração PostgreSQL real | migrations, SQL especial, atomicidade transacional, relistagem | Fases 2, 3 e 6 |
| HTTP Supertest | contratos, auth/papéis, erros e limites | Cada rota e gate final |
| WebSocket nativo | handshake/admission/mensagens/fechamento | Fases 4 e 6 |
| Front smoke | SSR, assets, fluxos essenciais em loopback | Fases 4 e 6 |
| Coleta CLI/worker + Redis real | contagens lidos/mapeados/gravados/descartados, ownership/lock BullMQ, autorização e cancelamento | Fases 5 e 6 |

Não há métricas de produção nem cutover. Execução somente loopback; nunca direcionar teste/migration a produção nem iniciar túnel/publicação. Nest nativo registra `/api/brands` no controller de catálogo; não montar `pilotBrandsModule` em paralelo. Fase 5 aguarda guarda/cancelamento, executor compartilhado e realocação de imports core; fase 6 aguarda browser smoke, cutover e rollback.
