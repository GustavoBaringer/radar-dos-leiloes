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
- **Phase / Task**: Phase 1 / T2 complete -> starting T3
- **Completed**: T1, T2
- **In-progress**: Iniciar T3 (enriquecer dados dos lotes casados no AlertsRepository com campos de slug)
- **Next step**: Implementar T3 em `src/infra/database/repositories/alerts.repository.ts`
- **Blockers**: none
- **Uncommitted files**: `src/application/services/accounts/accounts.service.ts`, `test/unit/accounts/accounts.service.test.mjs`, `.specs/*`
- **Branch**: feat/alertas-email-template
