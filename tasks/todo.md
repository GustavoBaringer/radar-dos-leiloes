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
- [ ] Etapa 4 — parcial para entrega operacional global; aceite local runtime/browser/fallback e backup/restore da fixture registrados. Backup/restore comparou 16 tabelas/schema normalizado/contagens; sem hash por linha/PITR/DR produção. Browser baseline `405a219` e candidate `4174814` PASS; Docker runtime HTTP interno passou. M3.5 validado localmente; M5.1 concluído localmente via CLI e processor worker; M5.2 parcial (hub/schedulers e `processarCollect` privado não testados); M5.3 pendente (cron/auxiliares/efeitos de notificações sem prova, pós-coleta worker foi stubbed). M6.1 parcial até gates M5.2/5.3; M6.2 parcial: schema empty/clone e restore fixture locais aprovados, sem rollback histórico/PITR/DR produção/canário. Ainda sem implantação/GO produção/cutover; default segue legado. Ingress HTTPS/WS e autorização pendentes; logout federado dispensado, não comprovado. Sem push/merge/deploy.
