# Backlog — migração NestJS + Prisma

Plano vinculado ao [ADR](adr/ADR-001-nest-prisma.md) e ao [PRD](prd/PRD-nest-prisma.md). Base `405a219`. Status inicial: **Pendente** para todo trabalho futuro; documentação desta etapa está em andamento e não declara implementação concluída. Donos são papéis sugeridos, não atribuições pessoais.

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
| M3.1 | 3 — Domínio/persistência | Modelar entidades, políticas e validadores puros; classes apenas com responsabilidade concreta. | M1.4, M2.3 | Domínio | Testes Jest cobrem regras existentes e casos limite documentados. | Pendente |
| M3.2 | 3 | Migrar persistência central para Prisma, mantendo SQL especial e transação de `upsertLots`. | M3.1, M2.4 | Persistência | Integração PostgreSQL comprova atomicidade, histórico e equivalência. | Pendente |
| M3.3 | 3 | Preservar filtragem imovel/veículo/escopo, anti-colecionáveis, mascaramento e normalização. | M3.1–M3.2 | Domínio/coleta | Fixtures/regressões impedem inserção/reabertura indevida e vazamento de placa. | Pendente |
| M3.4 | 3 | Preservar encerramento, fim nulo, relistagem e segunda praça. | M3.2 | Domínio/banco | Cenários de integração provam estados e histórico corretos. | Pendente |
| M3.5 | 3 | Preservar validação fonte/domínio e mecanismos existentes de lock BullMQ, autorização de persistência e cancelamento; manter transações PostgreSQL para escritas atômicas, sem presumir lock de tenant no PostgreSQL. | M3.2 | Banco/coleta/filas | Teste com Redis real valida lock/ownership BullMQ, autorização e cancelamento; teste PostgreSQL separado valida atomicidade transacional. | Pendente |
| M4.1 | 4 — HTTP, auth e plataforma | Migrar controllers/services/modules rota a rota; DTOs class-validator e Swagger compatível. | M1.1, M2.1, M2.5, M3 | API/backend | Supertest compara contratos e status por rota; documentação não altera contrato. | Pendente |
| M4.2 | 4 | Migrar identidade, Keycloak/OIDC/PKCE, cookies, papéis e autorização. | M1.2, M4.1 | Segurança/backend | Testes de sucesso/falha, expiração, assinatura e papel passam sem regressão. | Pendente |
| M4.3 | 4 | Integrar limites/anti-bot, streaming de imagens, SSR e assets com Fastify existente. | M1.2, M4.1 | Plataforma/web | Testes HTTP/stream e smoke frontend locais passam. | Pendente |
| M4.4 | 4 | Preservar WebSocket nativo e fluxo de admission/proteção. | M1.2, M4.1 | Plataforma/segurança | Cliente de teste valida upgrade, mensagens, negação e encerramento. | Pendente |
| M4.5 | 4 | Fazer cutover controlado de rotas compatíveis mantendo fallback legado. | M4.1–M4.4 | Backend/QA | Comparação em ambiente isolado sem diferença não aprovada; rollback ensaiado. | Pendente |
| M5.1 | 5 — Workers, CLI e infraestrutura | Migrar executor de coleta para serviços compartilhados entre CLI e workers BullMQ. | M3, M2.5 | Coleta/filas | Mesmo executor e políticas usados nos dois caminhos; teste/relatório de contagens. | Pendente |
| M5.2 | 5 | Integrar Redis, filas, cancelamento, timeout, scheduler e lifecycle Nest. | M5.1, M1.2 | Plataforma/filas | Integração em Redis isolado cobre shutdown, retry, cancelamento e concorrência. | Pendente |
| M5.3 | 5 | Migrar tarefas auxiliares/cron, observabilidade e notificações sem duplicar efeitos. | M5.1–M5.2 | Coleta/infra | Teste de execução prova idempotência esperada e métricas/logs úteis. | Pendente |
| M6.1 | 6 — Provas reais, retirada e entrega | Executar matriz completa: typecheck, build, Jest, PostgreSQL real, Supertest, WS e front smoke. | M4–M5 | QA/Backend | Todos os gates do PRD com evidência anexada; falhas bloqueiam cutover. | Pendente |
| M6.2 | 6 | Validar migrations em banco vazio e clone; revisar backup/rollback/canário. | M2.4, M6.1 | Banco/Operações | Equivalência assinada, rollback ensaiado; sem escrita de produção nesta etapa. | Pendente |
| M6.3 | 6 | Remover legado apenas após cobertura/aceite de todas as rotas e fluxos. | M4.5, M5, M6.1–M6.2 | Backend/tech lead | Inventário sem rota dependente, fallback dispensável e aceite operacional registrado. | Pendente |
| M6.4 | 6 | Entrega final, documentação operacional e pós-cutover monitorado/autorizado. | M6.3 | Operações/Backend | Plano de operação/rollback, métricas e decisão formal de encerramento. | Pendente |

## Estado de evidências e gates (contratos documentais concluídos; validações de runtime futuras)

| Verificação | Evidência esperada | Quando |
|---|---|---|
| Baseline Typecheck | `npm run typecheck` — baseline informado como Concluído; não rerun nesta etapa documental | Baseline M1.5; repetir após mudanças de código |
| Baseline Build | `npm run build:backend` — baseline informado como Concluído; não rerun nesta etapa documental | Baseline M1.5; repetir após mudanças de código |
| Baseline testes | 146 testes — baseline informado como Concluído; não rerun nesta etapa documental | Baseline M1.5; suites Jest/regressões novas continuam pendentes |
| Regressões Jest da migração | domínio, normalização, coleta e policies | A cada migração de regra |
| Integração PostgreSQL real | migrations, SQL especial, atomicidade transacional, relistagem | Fases 2, 3 e 6 |
| HTTP Supertest | contratos, auth/papéis, erros e limites | Cada rota e gate final |
| WebSocket nativo | handshake/admission/mensagens/fechamento | Fases 4 e 6 |
| Front smoke | SSR, assets, fluxos essenciais em loopback | Fases 4 e 6 |
| Coleta CLI/worker + Redis real | contagens lidos/mapeados/gravados/descartados, ownership/lock BullMQ, autorização e cancelamento | Fases 5 e 6 |

Sem baseline de desempenho/runtime produção nesta fase; não inventar números. Executar validações futuras somente em ambiente isolado/local; nunca direcionar teste ou migration a produção, nem iniciar túnel/publicação. `GET /api/brands` piloto permanece somente piloto; Jest/Supertest são dependências de teste, sem pacote adicional de runtime nesta lane. Nest core/platform-fastify permanecem dependências de runtime obrigatórias do alvo; nenhuma dependência foi alterada nesta fase.
