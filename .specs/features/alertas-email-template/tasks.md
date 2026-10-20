# Alertas Sem E-mail Manual e E-mail com Design System do Radar Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

---

**Design**: `.specs/features/alertas-email-template/design.md`
**Status**: Draft

---

## Test Coverage Matrix

> Generated from codebase, project guidelines, and spec - confirm before Execute. Guidelines found: `AGENTS.md`, `jest.config.mjs`, `plan-feature-nomeia-skill-de-validacao.md`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Domain / Search Request Bounds | unit | 1:1 com os ACs do ALERT-01 e ALERT-02; edge cases de validação | `test/unit/domain/request-bounds.test.mjs` | `npm run test:unit` |
| Application / Accounts Service | unit | Criação e atualização de alertas preenchendo actor.email; rejeição quando sem email | `test/unit/accounts/accounts.service.test.mjs` | `npm run test:unit` |
| Database / Alerts Repository | integration | Query de casamento de lotes trazendo campos de slug e fotos | `test/integration/database/alerts.repository.test.mjs` | `npm run test:integration` |
| Notifications / Email Template | unit | Renderização do DS do Radar, links `/lote/:slug`, escape HTML, text fallback | `test/unit/notifications/alert-email.templates.test.mjs` | `npm run test:unit` |
| Application / Notification Service | unit | Integração do envio de e-mails com novo template e registro de disparos | `test/unit/notifications/notification.service.test.mjs` | `npm run test:unit` |
| Frontend / Component SPA | unit | Diálogo de alerta sem input de email e com indicação informativa | `app-busca/src/components/DialogoAlerta.tsx` | `npm run typecheck` |
| Route / E2E Accounts & Notifications | e2e | Fluxo completo de criação de alerta sem e-mail e envio de notificações | `test/e2e/accounts/accounts-http.test.mjs` | `npm run test:e2e` |

## Gate Check Commands

> Generated from codebase - confirm before Execute.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | After tasks with unit tests only | `npm run test:unit` |
| Full | After tasks with integration tests | `npm run test:unit && npm run test:integration` |
| Build | After phase completion or final task | `npm run typecheck && npm run test:unit && npm run test:e2e` |

---

## Execution Plan

Phases are ordered and run sequentially - each phase completes before the next begins, and tasks within a phase run in order.

```
T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7
```

### Phase 1: Backend Foundation and Account Invariants

Tasks that must be done first, in order.

### Phase 2: Radar Design System Email Template Engine

Builds the visual template and notification integration.

### Phase 3: Frontend Alert Dialog Refinement

Adapts the user interface to remove manual email input.

### Phase 4: Full-Stack Verification and End-to-End Tests

Validates both frontend and backend proofs.


---

## Task Breakdown

### T1: Permitir canal de e-mail sem campo obrigatório na validação de entrada

**What**: Ajustar `ValidateAlertInput` para permitir canal email sem exigir parâmetro email estrito no corpo bruto da requisição.
**Where**: `src/domain/search/request-bounds.ts`
**Depends on**: None
**Reuses**: `src/domain/search/request-bounds.ts`
**Requirement**: ALERT-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `ValidateAlertInput` valida canais incluindo 'email' sem rejeitar quando `email` for omitido/indefinido
- [x] Validação de formato de e-mail é preservada caso um e-mail explícito seja fornecido
- [x] Testes unitários cobrindo o novo comportamento passam
- [x] Gate check passes: `npm run test:unit`
- [x] Test count: 38 testes passam sem regressão (+5 novos)

**Tests**: unit
**Gate**: quick

---

### T2: Auto-preencher e-mail do usuário autenticado no AccountsService

**What**: Injetar `actor.email` na criação e atualização de alertas no `AccountsService` quando o canal de e-mail estiver ativo.
**Where**: `src/application/services/accounts/accounts.service.ts`
**Depends on**: T1
**Reuses**: `src/domain/identity/identidade.ts`
**Requirement**: ALERT-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `createAlert` associa `actor.email` quando canal 'email' for selecionado e nenhum email informado no body
- [x] `updateAlert` preserva ou associa `actor.email` quando canal 'email' for selecionado
- [x] Rejeita com `AccountsServiceError(400)` se canal 'email' for selecionado mas usuário autenticado não possuir e-mail
- [x] Gate check passes: `npm run test:unit`
- [x] Test count: 39 testes passam sem erros (+1 novo cobrindo os cenários)

**Tests**: unit
**Gate**: quick

---

### T3: Enriquecer dados dos lotes casados com campos de slug no AlertsRepository

**What**: Adicionar campos de lote (`title_display`, `brand`, `model`, `year_model`, `doc_type`, `photos`, `city`, `state`) na query de `avaliarAlertas` e calcular o slug canônico em cada `Disparo`.
**Where**: `src/infra/database/repositories/alerts.repository.ts`
**Depends on**: T2
**Reuses**: `src/domain/lots/slug.ts`
**Requirement**: ALERT-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Consulta de lotes casados retorna campos necessários para o slug canônico
- [x] Objeto `Disparo` recebe o slug do lote gerado via `slugDoLote`
- [x] Nenhum lote duplicado ou com query inválida
- [x] Gate check passes: `npm run test:unit`
- [x] Test count: 40 testes passam sem erros (+1 novo cobrindo o repositório)

**Tests**: integration
**Gate**: full

---

### T4: Desenvolver template de e-mail de alerta com Design System do Radar

**What**: Criar módulo de template com tema escuro do Radar, cards de lotes, tipografia e links apontando para `/lote/:slug`.
**Where**: `src/infra/notifications/alert-email.templates.ts`
**Depends on**: T3
**Reuses**: `src/infra/notifications/onboarding-email.templates.ts`
**Requirement**: EMAIL-01

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] Template HTML implementa a paleta do Radar (`#05070f`, `#0b1120`, `#1e2941`, `#2f6bff`)
- [x] Links de cada lote apontam para `${siteUrl}/lote/${slug}`
- [x] Link geral de visualização do alerta aponta para `${siteUrl}/alertas?alertId=${alertId}`
- [x] Versão plain text estruturada gerada em conjunto
- [x] Sanitização com `escapeHtml` contra XSS e injeção
- [x] Suíte de testes unitários dedicada `test/unit/notifications/alert-email.templates.test.mjs` criada e passando
- [x] Gate check passes: `npm run test:unit`
- [x] Test count: 44 testes passam sem erros (+4 novos no módulo de template)

**Tests**: unit
**Gate**: quick

---

### T5: Integrar template de e-mail de alertas no NotificationService

**What**: Conectar `renderAlertEmail` ao método `enviarEmail` do `NotificationService`, substituindo a lista simples de texto.
**Where**: `src/application/services/notifications/notification.service.ts`
**Depends on**: T4
**Reuses**: `src/infra/notifications/alert-email.templates.ts`
**Requirement**: EMAIL-02

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [x] `enviarEmail` utiliza `renderAlertEmail` para gerar subject, html e text
- [x] URLs geradas respeitam variável de ambiente da URL pública da aplicação
- [x] Testes unitários de `NotificationService` atualizados e passando
- [x] Gate check passes: `npm run test:unit`
- [x] Test count: todos os 44 testes de notificação e domínio passam sem erros

**Tests**: unit
**Gate**: quick

---

### T6: Atualizar componente DialogoAlerta para remover campo de e-mail

**What**: Ocultar campo de texto de e-mail no formulário e exibir indicação contextual amigável com o e-mail da conta logada.
**Where**: `app-busca/src/components/DialogoAlerta.tsx`
**Depends on**: T5
**Reuses**: `app-busca/src/components/ui/button.tsx`
**Requirement**: EMAIL-03

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Campo `<input type="email">` removido do formulário
- [ ] Validação que bloqueava envio sem digitação de e-mail removida
- [ ] Mensagem informativa exibida ao marcar checkbox "E-mail" indicando envio para a conta
- [ ] Typecheck do frontend passa sem erros
- [ ] Gate check passes: `npm run typecheck`

**Tests**: unit
**Gate**: quick

---

### T7: Executar validação full-stack end-to-end

**What**: Criar e executar testes e2e validando a criação de alerta sem e-mail manual e o envio de notificações formatadas.
**Where**: `test/e2e/accounts/accounts-http.test.mjs`
**Depends on**: T6
**Reuses**: `test/e2e/accounts/accounts-http.test.mjs`
**Requirement**: EMAIL-04

**Tools**:

- MCP: NONE
- Skill: NONE

**Done when**:

- [ ] Teste e2e cobre POST `/api/alerts` com canal `email` sem campo `email` no corpo
- [ ] Valida que alerta gravado possui `email` do usuário logado
- [ ] Validação de front e de back executadas com sucesso
- [ ] Gate check passes: `npm run typecheck && npm run test:unit && npm run test:e2e`

**Tests**: e2e
**Gate**: build

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1:  T1 ------→ T2 ------→ T3
Phase 2:  T4 ------→ T5
Phase 3:  T6
Phase 4:  T7
```

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Permitir canal de e-mail sem campo obrigatório | 1 arquivo de validação | ✅ Granular |
| T2: Auto-preencher e-mail do usuário autenticado | 1 método no AccountsService | ✅ Granular |
| T3: Enriquecer dados dos lotes casados | 1 método no AlertsRepository | ✅ Granular |
| T4: Desenvolver template de e-mail de alerta com DS | 1 módulo de template + 1 arquivo de teste | ✅ Granular |
| T5: Integrar template no NotificationService | 1 método no NotificationService | ✅ Granular |
| T6: Atualizar DialogoAlerta na SPA | 1 componente React | ✅ Granular |
| T7: Validação full-stack e testes e2e | 1 arquivo de teste e2e | ✅ Granular |

---

## Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | None | ✅ Match |
| T2 | T1 | T1 -> T2 | ✅ Match |
| T3 | T2 | T2 -> T3 | ✅ Match |
| T4 | T3 | T3 -> T4 | ✅ Match |
| T5 | T4 | T4 -> T5 | ✅ Match |
| T6 | T5 | T5 -> T6 | ✅ Match |
| T7 | T6 | T6 -> T7 | ✅ Match |

---

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1: Permitir canal de e-mail sem campo obrigatório | Domain / Search Request Bounds | unit | unit | ✅ OK |
| T2: Auto-preencher e-mail do usuário autenticado | Application / Accounts Service | unit | unit | ✅ OK |
| T3: Enriquecer dados dos lotes casados | Database / Alerts Repository | integration | integration | ✅ OK |
| T4: Desenvolver template de e-mail com DS | Notifications / Email Template | unit | unit | ✅ OK |
| T5: Integrar template no NotificationService | Application / Notification Service | unit | unit | ✅ OK |
| T6: Atualizar DialogoAlerta na SPA | Frontend / Component SPA | unit | unit | ✅ OK |
| T7: Validação full-stack e testes e2e | Route / E2E Accounts & Notifications | e2e | e2e | ✅ OK |
