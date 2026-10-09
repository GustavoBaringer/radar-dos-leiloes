# Estado atual — 2026-10-09

Deploy público operacional. Login/Turnstile/busca confirmados pelo usuário.
Web e worker saudáveis; landing/vitrine/login 200, busca anônima 401.
Fontes e layout continuam originais: todas as correções visuais foram revertidas
a pedido do usuário. Não aplicar mobile-header.patch nem global-typography.patch.

Push corrigido e publicado, com CSS idêntico ao original. Registro aceita
expirationTime do navegador; Alertas sincroniza inscrição já autorizada.
Uma única notificação de teste enviada e recebimento confirmado pelo usuário.
Imagem web atual em push-build/image.json; patch funcional push-build/push-registration.patch.

Worker atualizado com limites por fonte, rotação de tenants e isolamento de
falhas no refresh. Imagem atual em finalization/worker-image.json; runtime
/etc/dokploy/radar-runtime/059af2b/workers.yml. Freitas/Superbid/Sua Plataforma
passaram em diagnóstico e na fila real: 10 lotes gravados por fonte.
Bom Valor/HTML Agenda/Leilão Pro também passaram pela fila, 1 lote gravado cada.
Últimas coletas: 46/48 bem-sucedidas; Suporte Leilões aguarda cooldown do circuito;
Caixa apresentou HTTP403. Testes limitados não comprovam cobertura completa.
Não declarar cobertura de todas as fontes validada. Encerramento por ausência
continua desligado; encerramento por prazo permanece ativo.

Usuário escolheu Brevo + Backblaze B2. Templates privados em /etc/radar;
orientações em SERVICOS-EXTERNOS.md. Sem credenciais dos provedores ainda.
Restic instalado e validado offline com upload/check/restore, criptografia,
rejeição de senha incorreta e de snapshot adulterado. Timer externo preparado,
desativado; nenhum upload B2 feito, nenhuma retenção/exclusão aplicada.
SMTP ainda não configurado, recuperação de senha/cadastro Keycloak desativados.

Runtime com IDs imutáveis, comando Dokploy em consolidation/dokploy-command.txt;
Deploy/Redeploy recriam apenas web/worker necessários, preservando infraestrutura.
Certificados/mTLS/renovação e backup local diário ativos. Todas as mutações de
relay usam relay/renew.lock. Manter arquivos privados e não imprimir segredos.
Esta atualização versiona somente os documentos. Patches funcionais e evidências
continuam na VPS em /root/radar-deploy. Checklist/evidências em CHECKLIST-deploy.md e
consolidation/live-deploy-status.json.


Último backup criado/restaurado: /root/radar-backups/predeploy-20261009T203534Z,
15 tabelas Radar e 101 Keycloak, restauração isolada sem rede. Inclui correções
push/worker, scripts/units externos e configurações privadas; node_modules excluído.
