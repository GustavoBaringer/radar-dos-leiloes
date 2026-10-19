# Alertas Sem E-mail Manual e E-mail com Design System do Radar - Design

## Architecture Overview

O fluxo de alertas envolve o ciclo completo desde a criação do alerta na interface SPA até o casamento de novos lotes e o envio da notificação transacional por e-mail.

```mermaid
flowchart TD
    subgraph Frontend [app-busca SPA]
        Modal[DialogoAlerta.tsx] -->|Checkbox E-mail sem input manual| APIClient[api.ts]
    end

    subgraph BackendAPI [NestJS Application]
        APIClient -->|POST /api/alerts| Controller[AccountsController]
        Controller --> Service[AccountsService]
        Service -->|Injeta actor.email se omitido| RepoAlerts[AccountsRepository]
    end

    subgraph NotificationEngine [Worker / Coleta]
        Worker[PostCollection / Worker] --> AlertRepo[AlertsRepository.avaliarAlertas]
        AlertRepo -->|Lotes novos com slug e metadados| Disparos[Disparo[]]
        Disparos --> NotifService[NotificationService.enviarEmail]
        NotifService --> TemplateEngine[alert-email.templates.ts]
        TemplateEngine -->|HTML DS + Links /lote/:slug| SMTP[SMTP Adapter]
    end
```

---

## Component Specifications

### 1. Frontend: Diálogo de Alerta (`app-busca/src/components/DialogoAlerta.tsx`)

- **Objetivo**: Permitir ao usuário marcar o canal de e-mail sem exigir que digite ou confira seu e-mail manualmente em um campo de texto.
- **Mudanças**:
  - Remoção do `<input type="email">` e do `useRef(campoEmail)`.
  - Remoção da trava de validação local que bloqueava o envio se o campo estivesse vazio.
  - Exibição de texto auxiliar informativo quando `canalEmail` for `true`, informando que os avisos serão enviados para o e-mail cadastrado da conta (obtido via prop ou contexto do usuário).
  - Envio do payload com `channels: [...canais]` e `email: emailDaConta || null`.

### 2. Backend API & Bounds: `AccountsService` e `ValidateAlertInput`

- **Objetivo**: Assegurar que qualquer alerta com canal `email` criado ou atualizado por usuário logado assuma `actor.email` quando `email` não for especificado no payload.
- **Mudanças em `src/domain/search/request-bounds.ts`**:
  - `ValidateAlertInput`: não falhar caso `channels.includes('email')` e `email` seja indefinido/nulo, permitindo que a camada de serviço autenticada preencha com o e-mail da sessão.
- **Mudanças em `src/application/services/accounts/accounts.service.ts`**:
  - Em `createAlert` e `updateAlert`: se `channels.includes('email')` e `!body.email`, atribuir automaticamente `actor.email`. Se `actor.email` for inválido ou ausente, lançar `AccountsServiceError(400, 'Conta sem e-mail válido para notificações.')`.

### 3. Modelo de Disparo e Dados do Lote (`alerts.repository.ts` & `alert-types.ts`)

- **Objetivo**: Fornecer ao serviço de notificações os dados necessários para gerar o slug do lote e renderizar os cards com o Design System.
- **Campos adicionados a `lots` na query de `avaliarAlertas`**:
  - `title_display`, `brand`, `model`, `year_model`, `doc_type`, `photos`, `city`, `state`.
- **Geração de Slug**:
  - O objeto `Disparo` recebe `slug: string` calculado a partir de `slugDoLote(lote)`.
  - A URL do lote é montada como `${siteUrl}/lote/${disparo.slug}`.

### 4. Template de E-mail de Alerta (`src/infra/notifications/alert-email.templates.ts`)

- **Objetivo**: Renderizar e-mails funcionais e responsivos com a identidade visual do Radar de Leilões.
- **Identidade Visual (Design System)**:
  - Fundo geral: `#05070f`
  - Container / Card: `#0b1120` com borda `1px solid #1e2941` e cantos arredondados (`border-radius: 16px`)
  - Tipografia:
    - Display / Headings: `'Space Grotesk', -apple-system, sans-serif`
    - Body: `'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
    - Números / Lances: `'JetBrains Mono', monospace`
  - Cores de Texto:
    - Títulos: `#eef3ff`
    - Secundário / Apoio: `#93a4c4` / `#6f809f`
    - Accent / Cyan: `#22d3ee`
  - Botões / CTAs:
    - Fundo `#2f6bff`, cantos em pílula (`border-radius: 999px`), texto branco em negrito.
- **Estrutura do E-mail**:
  - **Header**: Logo Radar de Leilões com ponto cyan característico.
  - **Destaque do Alerta**: Título com a quantidade de lotes e o nome do alerta salvo.
  - **Lista de Cards de Lotes**:
    - Cada lote em um bloco delimitado com borda e espaçamento interno.
    - Foto do lote (ou ícone padrão limpo).
    - Título do lote com link direto para o Radar.
    - Lance atual / mínimo destacado.
    - Badges com ano/modelo, localização (Cidade/UF) e fonte oficial.
    - Botão CTA: "Ver lote no Radar" direcionando para `${siteUrl}/lote/${slug}`.
  - **Ação Principal**: Botão no rodapé para acessar todos os resultados do alerta em `${siteUrl}/alertas?alertId=${alertId}`.
  - **Rodapé Institucional**: Informações de segurança, identificação da plataforma e link para gerenciar alertas.

---

## Code Reuse & Patterns

- Reuso de `slugDoLote` em `src/domain/lots/slug.ts` para garantir canonicidade estrita das URLs geradas.
- Reuso dos padrões de sanitização e montagem de e-mail de `src/infra/notifications/onboarding-email.templates.ts` (`escapeHtml`, validação de URLs seguras, tabelas de e-mail para compatibilidade).
- Reuso de `urlDoAlerta` em `src/domain/alerts/alerta-resumo.ts` para links de visualização de alertas.

---

## Risks & Concerns

| Risco / Preocupação | Severidade | Mitigação |
| ------------------- | ---------- | --------- |
| Cliente de e-mail bloqueando imagens externas | Média | O layout deve ser completamente legível e funcional mesmo com imagens desabilitadas (texto e botões estilizados sem depender de imagem). |
| Caracteres especiais em títulos de lotes causando quebra de HTML ou injeção | Alta | Todo dado dinâmico (`title`, `label`, `source`) é estritamente escapado com `escapeHtml`. |
| Ausência de `PUBLIC_URL` / `SITE_URL` configurado | Baixa | Fallback seguro para `http://localhost:4500` em desenvolvimento ou valor relativo seguro. |
| Incompatibilidade com clientes antigos da API que passam `email` explícito | Nenhuma | A API continua aceitando o campo `email` se enviado, apenas preenchendo automaticamente com o da conta quando omitido. |
