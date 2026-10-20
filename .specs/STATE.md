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
- **Phase / Task**: Phase 2 / T3 complete -> starting T4
- **Completed**: T1, T2, T3
- **In-progress**: Iniciar T4 (desenvolver template de e-mail de alerta com Design System do Radar)
- **Next step**: Implementar `src/infra/notifications/alert-email.templates.ts`
- **Blockers**: none
- **Uncommitted files**: `src/domain/alerts/alert-types.ts`, `src/infra/database/repositories/alerts.repository.ts`, `test/unit/notifications/alerts.repository.test.mjs`, `.specs/*`
- **Branch**: feat/alertas-email-template
