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

- [ ] Etapa 2: transações administrativas Prisma e retirada de pg.connect; prova real de rollback/dry-run/CAS/backup.
- [ ] Etapa 3: QA agregado, benchmark 15 mil lotes e revisão final.
- [ ] Etapa 4: browser/runtime/Docker, runbooks de deploy/rollback e cutover controlado.
