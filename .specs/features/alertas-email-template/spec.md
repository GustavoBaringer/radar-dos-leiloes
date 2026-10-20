# Alertas Sem E-mail Manual e E-mail com Design System do Radar Specification

## Problem Statement

Atualmente, ao criar ou editar um alerta no Radar de Leilões, o formulário exige que o usuário digite manualmente seu e-mail caso selecione notificações por e-mail, mesmo já estando autenticado na plataforma. Além disso, as mensagens de e-mail de alertas enviadas aos usuários são puramente em texto/HTML rudimentar e contêm links direcionando diretamente para os sites externos dos leiloeiros, prejudicando a experiência de navegação do usuário e a retenção dentro do ecossistema do Radar.

## Goals

- Eliminar a solicitação de preenchimento manual de e-mail no formulário de alerta, vinculando automaticamente a notificação ao e-mail da conta logada.
- Desenvolver um template de e-mail transacional para alertas aderente ao Design System do Radar (dark theme, paleta técnica, tipografia, badges e cards estruturados).
- Garantir que todos os links de lotes no e-mail direcionem para a visualização canônica do lote dentro do próprio Radar (`/lote/:slug`), com fallback seguro para a listagem do alerta (`/alertas?alertId=...`).

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
| ------- | ------ |
| Alteração da periodicidade ou do motor de agendamento de coletas diárias | O escopo restringe-se à entrada de dados do alerta e à formatação/direcionamento da entrega por e-mail. |
| Criação de novas preferências granulares de e-mail (ex: digest semanal, frequência customizada) | Fora do escopo atual; o modelo de entrega existente por coleta/lote permanece inalterado. |
| Redesenho de outros e-mails do sistema (ex: boas-vindas, recuperação) | O foco é estritamente o e-mail de novos lotes encontrados por alertas salvos. |

---

## Assumptions & Open Questions

Every ambiguity is resolved or recorded here - nothing is left silently unclear.

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --------------------- | -------------- | --------- | ---------- |
| E-mail do usuário no alerta | Associar automaticamente o e-mail do usuário logado (`actor.email`) quando o canal `email` for ativado e nenhum e-mail for fornecido | Evita fricção desnecessária para o usuário logado e mantém compatibilidade retroativa na API | Sim |
| URL base para links nos e-mails | Usar variável de ambiente (`PUBLIC_URL` ou `SITE_URL`), caindo para `http://localhost:4500` em ambiente de desenvolvimento | Garante que os links funcionem em produção e em testes locais sem hardcoding | Sim |
| Rota de visualização de lote no Radar | Utilizar a rota canônica `/lote/:slug` já existente na plataforma | Mantém a experiência de produto, preserva SEO/OG metadata e retém o usuário na plataforma | Sim |
| Exibição do e-mail no formulário | Exibir texto informativo contextual com o e-mail da conta ao marcar a opção "E-mail", sem campo `<input>` de texto | Dá transparência ao usuário sobre para onde a mensagem irá sem solicitar digitação | Sim |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Criação de Alerta sem Solicitação de E-mail ⭐ MVP

**User Story**: Como usuário autenticado no Radar, quero criar um alerta marcando a opção de receber por e-mail sem precisar redigitar meu e-mail, para que o processo seja rápido e integrado à minha conta.

**Why P1**: Elimina a maior fricção do formulário de alertas e cumpre o requisito primário do usuário.

**Acceptance Criteria** (EARS notation):

1. WHEN o usuário abrir o diálogo de criação de alerta THEN the system SHALL ocultar o campo de texto para digitação de e-mail.
2. WHILE a opção de notificação por e-mail estiver marcada, the system SHALL exibir o e-mail cadastrado da conta logada como destinatário informativo.
3. WHEN o usuário enviar o formulário com o canal "email" ativo THEN the system SHALL gravar o alerta associado ao e-mail da conta do usuário autenticado.
4. IF a requisição à API de criação ou atualização de alertas contiver o canal "email" e omitir o campo "email" THEN the system SHALL atribuir o endereço de e-mail da identidade autenticada (`actor.email`).
5. IF a identidade autenticada não possuir e-mail válido THEN the system SHALL recusar a ativação do canal de e-mail com mensagem amigável.

**Independent Test**: Abrir modal de criação de alerta logado, marcar canal de e-mail, verificar ausência de input manual e confirmar que o alerta salvo no banco recebe o e-mail do usuário.

---

### P2: Template de E-mail com Design System do Radar e Links Internos

**User Story**: Como usuário que recebe notificações de alerta, quero receber um e-mail estruturado visualmente com o Design System do Radar e com botões/links direcionando para o próprio Radar, para que eu visualize os detalhes completos dos lotes na plataforma.

**Why P2**: Substitui o e-mail em texto puro por uma comunicação profissional com alta conversão e navegação integrada ao Radar.

**Acceptance Criteria** (EARS notation):

1. The system SHALL renderizar o e-mail de alerta em formato HTML responsivo baseado no Design System do Radar (fundo `#05070f`, card `#0b1120`, bordas `#1e2941`, tipografia legível e destaques de marca `#2f6bff`).
2. WHEN houver novos lotes casados com o alerta THEN the system SHALL renderizar cartões visuais para os lotes contendo título, lance formatado, detalhes principais e botão de ação.
3. WHEN qualquer link de lote no e-mail for clicado THEN the system SHALL direcionar o usuário para a URL do lote no Radar (`/lote/:slug`) e não para a URL externa do leiloeiro.
4. The system SHALL incluir um link para visualizar todos os lotes do alerta diretamente no Radar (`/alertas?alertId=...`).
5. The system SHALL gerar uma versão multipart/alternative em texto puro estruturado contendo os mesmos links internos do Radar.
6. IF o título do lote ou dados da fonte contiverem caracteres especiais ou tentativas de injeção THEN the system SHALL escapar devidamente o HTML e sanitizar as URLs.

**Independent Test**: Disparar e-mail de alerta para um lote teste e verificar a estrutura HTML renderizada, paleta de cores e links apontando para `${siteUrl}/lote/${slug}`.

---

## Edge Cases

- IF o lote não possuir marca ou modelo cadastrados THEN the system SHALL gerar o slug canônico com base no título e ID do lote conforme especificação de slug.
- IF o usuário editar um alerta desmarcando o canal de e-mail THEN the system SHALL remover o canal sem invalidar os demais canais do alerta.
- IF o servidor SMTP estiver indisponível THEN the system SHALL registrar a falha de envio mantendo o registro de disparos pendentes para reprocessamento.

---

## Requirement Traceability

Each requirement gets a unique ID for tracking across design, tasks, and validation.

| Requirement ID | Story | Phase | Status |
| -------------- | ----- | ----- | ------ |
| ALERT-01 | P1: Criação de Alerta sem Solicitação de E-mail | Execute | Verified |
| ALERT-02 | P1: Criação de Alerta sem Solicitação de E-mail | Execute | Verified |
| ALERT-03 | P1: Criação de Alerta sem Solicitação de E-mail | Execute | Verified |
| EMAIL-01 | P2: Template de E-mail com Design System do Radar | Tasks | Pending |
| EMAIL-02 | P2: Template de E-mail com Design System do Radar | Tasks | Pending |
| EMAIL-03 | P2: Template de E-mail com Design System do Radar | Tasks | Pending |
| EMAIL-04 | P2: Template de E-mail com Design System do Radar | Tasks | Pending |

**Coverage:** 7 total, 7 mapped to tasks, 0 unmapped.

---

## Success Criteria

- [ ] Nenhum formulário de alerta exibe caixa de texto de e-mail para usuário logado.
- [ ] Alertas salvos com canal de e-mail herdam confiavelmente o e-mail da sessão autenticada.
- [ ] Template de e-mail é gerado com o Design System oficial do Radar (dark mode, cards, botões).
- [ ] 100% dos links de lotes no e-mail apontam para `/lote/:slug` dentro do Radar.
- [ ] Suítes de testes unitários e de integração de frontend e backend executam com sucesso.
