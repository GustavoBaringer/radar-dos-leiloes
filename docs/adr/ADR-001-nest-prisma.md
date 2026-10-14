# ADR-001 — Migração incremental para NestJS e Prisma

- **Status:** Aceito; implementação em andamento (não concluída).
- **Data:** 2026-10-14
- **Base de referência:** `405a219`.

## Contexto

O backend é ESM TypeScript e roda em Fastify, com build compilado existente (`package.json:5-15`, `scripts/build-backend.mjs`). O host concentra HTTP, sessão/OIDC/PKCE, papéis, recursos anti-bot e streaming; há também WebSocket nativo, arquivos estáticos e renderização web (`src/legacy-host.ts:1-39`; `src/core/antibot/ws-admission.ts`). Aproximadamente 40 rotas constituem contratos existentes; a migração não pode alterar seus envelopes, permissões, cookies, códigos, cabeçalhos ou comportamento de assets/streaming.

Nest 12 e `@nestjs/platform-fastify` já estão instalados (`package.json:38-40`). Há um módulo piloto de brands, fora do bootstrap de produção, montado sobre o host e adapter Fastify existente (`src/legacy-nest-host-brands.ts:63-92`). A persistência usa `pg` e SQL explícito (`src/core/db.ts`; `src/core/repo.ts:1-8`). Os 16 scripts `db/001_schema.sql` a `db/016_tenant_collection_attempts.sql` contêm 15 `CREATE TABLE`; não há ledger de migrações. PostgreSQL, Redis, BullMQ e Keycloak/OIDC são dependências operacionais existentes.

Regras centrais não são detalhes intercambiáveis de ORM: `upsertLots` aplica filtro de escopo e normalização, mantém histórico de lances e escreve lote em transação (`src/core/repo.ts:44-56`, `:72-100`); encerramento, relistagem, `fim=NULL` e segunda praça têm semântica compartilhada (`src/core/encerramento.ts`). A execução de coleta é compartilhada entre worker e CLI (`src/core/collection-execution.ts`, `src/queue/worker.ts:43-59`, `scripts/collect.ts`). A ingestão multi-tenant depende de origem/domínio e locks antes de persistir.

## Decisão

1. Reimplementar gradualmente a aplicação usando NestJS, com controllers, services e modules em `src/application/{controllers,services,modules}`; entidades, políticas e validadores puros ficam no domínio. Classes representam responsabilidades concretas. Criar interfaces somente nas fronteiras reais de I/O; não introduzir generic repository, CQRS ou microsserviços.
2. Preservar Fastify via `FastifyAdapter`, Node 24, ESM e o build compilado já usado. Manter PostgreSQL, Redis, BullMQ, Keycloak/OIDC, parsers, conectores, web/SSR/assets e WebSocket nativo; não substituir WebSocket por Socket.IO.
3. Adotar Prisma 7 com versão fixada, configuração própria (`prisma.config.ts`) e adapter PostgreSQL `pg`. Preservar SQL especializado quando necessário, usando o Prisma Client e sua transação para coordenar o trabalho atômico; não forçar cada consulta a uma abstração ORM.
4. Migrar por contratos e capacidade, com compatibilidade HTTP e executor compartilhado por worker/CLI. Implementar class-validator em DTOs de entrada e classes TypeScript explícitas; documentar HTTP via Swagger sem mudar os contratos publicados.
5. Não executar migração destrutiva nem aplicar baseline em produção. O baseline deve representar integralmente o banco vazio; só marcar o banco como aplicado em clone após provar equivalência do schema. Migração real exige backup, plano de rollback e aprovação operacional.

## Alternativas consideradas

- **Manter Fastify/SQL sem Nest/Prisma:** menor mudança, mas não atende à autorização de reimplementação e mantém o formato arquitetural atual.
- **Trocar tudo de uma vez:** rejeitada pelo risco de quebrar dezenas de contratos, coleta/locks e funções operacionais difíceis de reverter.
- **Nest com Express ou Socket.IO:** rejeitada por incompatibilidade com Fastify, streaming e WebSocket nativo existentes.
- **Prisma para toda consulta ou repository genérico/CQRS:** rejeitado; SQL especial e transações explícitas são necessários, e as abstrações não têm benefício demonstrado.
- **Baseline sobre banco existente sem equivalência:** rejeitada por risco de mascarar drift ou omitir scripts de schema.

## Consequências

- Migração incremental mantém os dois adaptadores/caminhos temporariamente; haverá custo de compatibilidade até cada rota ser transferida.
- Schema Prisma e 16 SQLs precisam de reconciliação rigorosa, incluindo constraints, índices, defaults e funções/SQL especial. Não presumir equivalência por contagem de tabelas.
- Prisma transacional deve manter atomicidade das gravações de lote e histórico. Locks de tenant/origem devem continuar sendo adquiridos antes de qualquer escrita.
- Testes de contrato e execução em PostgreSQL real são gates; mocks não provam comportamento de SQL/locks.
- Sem escrita em produção, sem exposição pública local e sem túneis de rede/publicação durante desenvolvimento ou validação.

## Rollback

Por etapa, manter a rota ou executor anterior disponível até comparação de contrato e aprovação; reverter o roteamento para o legado sem alterar dados. Mudanças de schema exigem migration reversível ou restauração de backup; nunca executar rollback destrutivo automático. Baseline só é aplicável em clone validado. Registrar decisão e evidência antes de avançar banco compartilhado.

## Aceite

Aceita a direção de arquitetura e migração; não declara implementado Nest, Prisma, schema, rotas ou retirada do legado. A conclusão exige os critérios e evidências em [PRD](../prd/PRD-nest-prisma.md) e [backlog](../migration-tasks.md).
