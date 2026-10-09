# Checklist do deploy — atualizado em 2026-10-09

- [x] Publicar https://radardeleiloes.app.br com autorização do usuário; landing/vitrine/login 200, busca anônima 401, HTTP redireciona para HTTPS.
- [x] Validar login, desafio Turnstile e busca com confirmação do usuário.
- [x] Manter caminho mTLS Traefik → relay → web e bloquear acesso direto à origem.
- [x] Automatizar renovação de certificados com timer, prova do caminho, rollback e testes de cancelamento.
- [x] Consolidar Deploy/Redeploy Dokploy com runtime persistente e imagens fixadas, preservando PostgreSQL, Keycloak e volumes.
- [x] Ativar worker saudável com Chromium, coleta/refresh serializados, limites de memória/CPU e agendas no fuso America/Sao_Paulo.
- [x] Validar coleta limitada Leilo, fila BullMQ, descoberta limitada, compilação e testes de cancelamento/limites.
- [x] Iniciar primeira rodada das 48 fontes, com espaçamento e limites; acompanhar resultados por conector.
- [x] Ativar backup local diário às 03:30 de São Paulo, validar checksums e restauração isolada dos bancos Radar e Keycloak.
- [x] Configurar chaves VAPID no web e worker.
- [x] Reverter todas as alterações visuais; estilos originais preservados na nova imagem com correção funcional de push.
- [ ] Fontes e layout no celular: adiado expressamente pelo usuário. Tentativas de correção revertidas; não aplicar patches visuais sem nova solicitação.
- [x] Corrigir registro/sincronização push e validar uma única notificação: serviço aceitou HTTP201; usuário confirmou recebimento no celular.
- [ ] Configurar SMTP para e-mails e recuperação de conta: Brevo escolhido; aguarda credenciais em /etc/radar/smtp.json (template privado pronto). Cadastro público de conta e reset no Keycloak permanecem desativados.
- [ ] Configurar destino externo e política de retenção dos novos backups: Backblaze B2 escolhido; aguarda credenciais em /etc/radar/external-backup.json. Restic criptografado validado offline; timer externo instalado e desativado; nenhum upload remoto/exclusão feito.
- [x] Publicar limites por fonte, rotação de tenants e isolamento de falhas no refresh; typecheck/testes passaram, Freitas/Superbid/Sua Plataforma gravaram 10 lotes cada; Bom Valor/HTML Agenda/Leilão Pro gravaram 1 lote cada pela fila real.
- [ ] Acompanhar cobertura e falhas restantes: 46/48 fontes com última coleta bem-sucedida nesta conferência; Suporte Leilões em cooldown; Caixa com 403 upstream. Os testes limitados não comprovam cobertura completa do catálogo. Jobs completados podem incluir skip por circuito; não equivalem a fonte validada.
- [ ] Avaliar encerramento por ausência somente após histórico de coletas completas bem-sucedidas; atualmente desligado. Encerramento por prazo ativo.

Evidências na VPS, sob /root/radar-deploy: consolidation/live-deploy-status.json, consolidation/public-access-result.json,
worker-build/worker-deployment.patch e ui-review/production-metrics.jsonl.
Último backup restaurado em ambiente isolado: /root/radar-backups/predeploy-20261009T203534Z.
Não usar Start/Stop/Reset/Delete do painel como substitutos de Deploy/Redeploy: não seguem o comando consolidado.
