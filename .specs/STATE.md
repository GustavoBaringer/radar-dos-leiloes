# Project Memory

## Decisions

### AD-001
- **Decision**: Alertas com canal de e-mail herdam automaticamente o e-mail da conta logada (`actor.email`) quando omitido, e os e-mails de alerta passam a conter links canônicos para `/lote/:slug` dentro do Radar com o Design System oficial.
- **Reason**: Reduzir a fricção do usuário no formulário de criação de alertas e manter a retenção e experiência de navegação dentro do ecossistema do Radar de Leilões.
- **Trade-off**: O objeto `Disparo` e a query de lotes no casamento precisam carregar campos para o cálculo do slug do lote (`brand`, `model`, etc.).
- **Scope**: `src/domain/search`, `src/application/services/accounts`, `src/application/services/notifications`, `src/infra/notifications`, `app-busca`
- **Date**: 2026-10-19
- **Status**: active

---

## Handoff

- **Feature**: alertas-email-template
- **Phase / Task**: Phase 4 / T7 complete -> Feature Verified & Complete
- **Completed**: T1, T2, T3, T4, T5, T6, T7
- **In-progress**: Feature concluída e aprovada pelo Verifier independente
- **Next step**: Merge da branch `feat/alertas-email-template` quando autorizado pelo usuário
- **Blockers**: none
- **Uncommitted files**: none
- **Branch**: feat/alertas-email-template
- **Verdict**: PASS (7/7 ACs, 3/3 sensor, 0 erros de tipo, 100/100 testes passaram)
