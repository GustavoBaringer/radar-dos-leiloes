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
- [ ] Etapa 4 — parcial para entrega operacional global; aceite local runtime/browser/fallback e backup/restore fixture registrados. M3.5/M5.1 aprovados localmente. M5.2 hub real/schedulers/regular+daily/shutdown PASS, e durable lifecycle test opt-in `test/integration/queue/worker-hub-lifecycle.test.mjs` PASS 1/1, skip 0, natural exit 0/signal null (~27.5s; `/tmp/opencode/phase5-lifecycle-durable.execution.log`). M5.3 matching/idempotência fake transports e daily scheduler/job comprovados; cron integral e SMTP/VAPID externo não executados. M6.1/M6.2 evidências locais exercitadas aprovadas, mas rollback histórico/PITR/DR produção/canário pendentes. M4.5 cutover e M6.3/M6.4 retirada legado/entrega global pendentes. Default legado; sem implantação; ingress HTTPS/WS e autorização pendentes. Logout federado dispensado, não comprovado. Sem push/merge/deploy.
- [x] Cutover local validado: `npm start` builda e inicia Nest compilado; `dev` é alias sem watch, `start:compiled` reutiliza o build; fallbacks `*:legacy` preservados. Smoke loopback passou e SIGTERM liberou porta; fixture permaneceu 54/0/0. TSX Nest source falhou sem stderr (causa indeterminada), não é caminho suportado. Docker/produção legado; sem deploy/publicação. Evidência: `/tmp/opencode/local-cutover-logs/npm-start-compiled-default.jsonl`.
