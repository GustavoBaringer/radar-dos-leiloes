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
- **Phase / Task**: Phase 4 / T6 complete -> starting T7
- **Completed**: T1, T2, T3, T4, T5, T6
- **In-progress**: Iniciar T7 (validação full-stack e testes e2e de ponta a ponta)
- **Next step**: Atualizar `test/e2e/accounts/accounts-http.test.mjs` para testar fluxo completo de alerta e notificação
- **Blockers**: none
- **Uncommitted files**: `app-busca/src/components/DialogoAlerta.tsx`, `app-busca/src/App.tsx`, `.specs/*`
- **Branch**: feat/alertas-email-template
