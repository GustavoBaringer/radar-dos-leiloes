# Continuação serial da migração

## Etapa 1: anti-bot restante

- [x] A. Contratos e IP: mover types/ip para destinos canônicos, manter reexports e referências; executar typecheck e testes existentes de IP/config. Escopo pequeno, sem alterar políticas. Dependência: nenhuma.
- [x] B. Engine/config/default observer: separar configuração e orquestração sem mudar estado, quotas ou degradação; preservar criação única. Verificar testes engine/config/Fastify e build. Dependência: A.
- [x] C. Telemetria/resources/guard HTTP: mover implementações preservando singleton, cardinalidade e status; verificar testes resources/operations. Dependência: B.
- [x] Checkpoint: comparar exportações e corpos dos recortes A–C; typecheck/build e testes direcionados aprovados. Revisão Oracle liberou o recorte sem P1/P2 introduzido; GO limitado a A–C.
- [x] D. WS/admission/challenge: mover implementações preservando ownership, timers e cleanup; verificar testes fake de WS e challenge/HTTP. Dependência: C.
- [x] E. Imagens/telemetria/log/routes/proxy: realocar sem mudar limites, cache ou persistência; verificar images/operations/proxy e regressões HTTP pertinentes. Dependência: D.
- [x] F. Conferência final: inventário completo de core conferido; duplicação residual de freio substituída por métodos bound do serviço. Typecheck, sete testes puros e teste Nest do freio aprovados. Anti-bot A–E revisado sem P1/P2 introduzido. Core/db administrativo fica explicitamente na etapa 2; aposentadoria dos shims na etapa 4.

## Etapas posteriores — não iniciar antes do gate anterior

- [x] Etapa 2: quatro scripts migrados para transações Prisma; gateway core/db.pool.connect retirado. Provas PostgreSQL dos callbacks/CAS/rollback e falha de backup aprovadas; revisão Oracle sem P1/P2 introduzido. Limites de cleanup e concorrência registrados em admin-layer5.md; sem apply de produção.
- [x] Etapa 3: QA agregado aprovado (Jest 121, isolated 146, compiled 20), benchmark 15 mil lotes / 30 mil históricos e revisão final Oracle GO. Tempos 58,515 s / 52,743 s; provas dedicadas reutilizadas e limites registrados em aggregate-qa3.md.
- [ ] Etapa 4 — parcial: runtime compilado aprovado (startup, rotas, `/health` autenticado, SIGTERM com exit 0 e porta liberada). Browser Chromium real aprovado em login por senha, PKCE com callback no Keycloak de fixture, WebSocket `hello`, assets 200 e logout local. Startup medido em 43,35 s (import ESM 24,2 s), o que invalidou prazos de 30 s. Docker bloqueado: `Dockerfile:3` exige `apt-get` com rede, não disponível nesta máquina. Logout federado não comprovado por decisão do usuário (fixture de teste só aceita `/auth/callback`; app volta para `/login`). Restam: gate Docker, gate de falsificação do browser, runbook de rollback e decisão de cutover. Default continua legado.
