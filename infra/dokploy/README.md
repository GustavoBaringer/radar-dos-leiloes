# Produção no Dokploy

O site público está operacional conforme o registro herdado de 2026-10-09; este
guia é referência operacional, não autorização para alterar a VPS. Não executar
ações de VPS nesta máquina empresarial: operações ficam a cargo do usuário, no
navegador externo. Não usar SSH, túneis, IPs/domínios reais ou credenciais locais.

## Estado operacional e cautelas — 2026-10-09

- O registro herdado informa 46/48 fontes com coleta bem-sucedida na última
  conferência; isso é cobertura limitada, não validação completa. Caixa retornou
  403 e Suporte Leilões aguarda cooldown. Encerramento por ausência segue desligado.
- Todas as alterações visuais foram revertidas. Patches de produção e evidências
  permanecem na VPS em `/root/radar-deploy`; reconciliar arquivos locais não prova
  que houve novo deploy. Não fazer ações destrutivas no painel (Start/Stop/Reset/Delete).
- O runtime usa IDs imutáveis; o comando consolidado de Deploy/Redeploy está em
  `/root/radar-deploy/consolidation/dokploy-command.txt`, e o worker runtime em
  `/etc/dokploy/radar-runtime/059af2b/workers.yml` (referência operacional;
  não executar daqui). Limites exatos por fonte e rotação de Sua Plataforma ainda
  não estão reconciliados localmente: aguardar acesso a
  `/root/radar-deploy/worker-build/worker-deployment.patch`.
- Backup local diário está ativo. O último backup foi restaurado isoladamente em
  `/root/radar-backups/predeploy-20261009T203534Z` (15 tabelas Radar e 101 Keycloak).
- Não há autorização para mudanças de runtime ou mutações de produção neste fluxo.

## Pré-requisitos e gates

1. Preparar VPS/Dokploy e DNS/TLS fora deste computador. No painel, configurar
   domínios `radardeleiloes.app.br` → serviço `web:4500` e
   `auth.radardeleiloes.app.br` → `keycloak:8080`. O painel/Traefik conecta sua
   rede proxy existente somente aos dois serviços. Não criar `ports` publicados.
   O proxy precisa enviar `X-Forwarded-*`; confirmar o CIDR estrito do proxy e
   comprovar bloqueio de acesso direto à origem. O código também lê
   `X-Forwarded-Proto` bruto: testar spoofing desses cabeçalhos antes de confiar
   no proxy. Não presumir que uma rede compartilhada do Dokploy é isolada.
2. Configurar secrets a partir de `production.env.example` no cofre do Dokploy,
   nunca versionar o arquivo preenchido. Configure também o `OIDC_CLIENT_SECRET`
   do client confidencial `radar-web`; ele pode ficar vazio no bootstrap, mas é
    obrigatório antes de iniciar `web`. Senhas usadas dentro de URLs devem ser
   URL-safe (sem caracteres reservados); não se presume codificação automática.
    Definir TURNSTILE real para o hostname servido (não depende de Cloudflare DNS
    ou CDN), sessão, senhas e CIDRs estreitos. O ACK de proteção da origem deve
    permanecer vazio até verificação operacional independente; CIDRs precisam
    ser verificados, não preenchidos por suposição.
3. **Template de bootstrap Compose:** antes de qualquer escrita pública nova,
    validar backup externo e um restore
    testado, com identidade de usuários preservada por `sub`/roles, sem merge por
    e-mail. Este template não configura backup automatizado nem SMTP/recuperação;
    isso não descreve o estado do backup local documentado acima.
   Manter registro público e self-registration do Keycloak desabilitados no
   início; preparar canal de suporte/recuperação manual antes de abrir cadastro.

## Ordem de implantação controlada

1. A interpolação do Compose valida variáveis obrigatórias de todos os serviços,
   mesmo quando se selecionam serviços para iniciar. Para a fase de Postgres e
   Keycloak, forneça credenciais do Postgres, Redis e Keycloak, além de
   `KEYCLOAK_VERSION` como versão patch exata `26.x.y` revisada. Revise notas de
   release, segurança e migração antes de escolher a versão; não use `latest` nem
   atualize automaticamente. Os segredos exclusivos do `web` (`OIDC_CLIENT_SECRET`,
   sessão, Turnstile, CIDRs e ACK de origem) podem permanecer vazios nesta fase;
   OIDC_CLIENT_SECRET será obrigatório antes de iniciar `web`. Isso só permite
   validar/renderizar a configuração e não permite que o serviço `web` inicie.
   O comando do `web` falha antes de executar o Node enquanto faltarem valores
   obrigatórios, e exige ACK de origem exatamente `1`; os modos antibot continuam
   `enforce` e a configuração de confiança do proxy não ganha fallback.
   No Dokploy, use um comando Compose customizado equivalente ao abaixo,
   preservando o nome/flags de projeto que o
   Dokploy gerar. Confira o comando renderizado e confirme que somente
   `postgres` e `keycloak` foram iniciados. Não assuma que a interface oferece
   seleção de serviços e nunca rode deploy da stack inteira nesta fase.

   ```sh
   docker compose -p <projeto-existente> -f docker-compose.production.yml up -d postgres keycloak
   ```

   PostgreSQL cria apenas as duas databases e
   roles no volume vazio; as senhas bootstrap são necessárias nessa primeira
   inicialização. `init-databases.sh` não executa migrations. Não reutilizar
   volume existente sem avaliar cuidadosamente o estado.
2. O template sanitizado de realm novo está disponível em
   `infra/dokploy/realm-radar.json`, mas o Compose de produção sobrescreve
   intencionalmente o CMD padrão de import do Dockerfile. Provisionar/configurar
   realm `radar` manualmente, ou restaurar backup verificado preservando usuários,
   `sub`, clients e roles. Não importar automaticamente o realm de desenvolvimento
   nem contar com import no startup como sincronização: import não reconcilia
   mudanças em realm já existente. Não recriar identidades existentes; preserve
   seus `sub`.
   Conferir client `radar-web`, callback/logout URLs e role `radar-admin`.
3. Comparar schema e dados restaurados com a versão do app. `scripts/migrate.ts`
   reexecuta SQL 011 e pode alterar propriedade; não o executar automaticamente
   nem sobre produção sem revisão/aprovação explícita. O servidor faz
   `ensureSources` na inicialização, portanto não iniciar `web` antes da
   aceitação da restauração e das migrations necessárias.
4. Validar OIDC, HTTPS, Turnstile, CIDRs/origem, logs e backup/restore com acesso
   restrito; só então iniciar `web` e fazer teste controlado antes de permitir
   escrita pública. `web` e Keycloak não têm portas de host no Compose.
5. Antes de qualquer rollout real, validar build da imagem e runtime da versão
   Keycloak selecionada em ambiente externo controlado; `docker compose config`
   apenas valida interpolação e sintaxe, não testa imagem, build ou runtime.

## Recursos e limitações

PostgreSQL 16 tem databases/roles separados; Redis 7 exige autenticação, AOF,
`noeviction` e limite configurado de 128 MiB para deixar margem à memória do
Redis/AOF dentro do container limitado a 256 MiB. Limites de memória: web 768 MiB,
Keycloak 1 GiB, PostgreSQL 768 MiB e Redis 256 MiB; são limites, não reserva nem
garantia de capacidade. Há volumes persistentes locais, não substituem backup.
`backend` é interna; `web` também usa rede de saída para OIDC/Turnstile. Rede
proxy é anexada pelo Dokploy e não declarada aqui. Management do Keycloak em
9000 fica privado.

**Limite do template Compose:** não há worker nesta stack; jobs/coletas não
executam nela. O worker saudável citado no estado operacional é um runtime de
produção separado, não declarado por este Compose. Projetar worker separado para
novas implantações somente com gate de recursos e execução aprovados. Sem SMTP não
há promessa de recuperação de conta por e-mail; backup local não substitui backup
externo testado antes de habilitar escrita pública em uma nova implantação.

## Integrações externas pendentes

Brevo e Backblaze B2 foram escolhidos em 2026-10-09; ambos seguem bloqueados por
credenciais ausentes. Os caminhos abaixo são **arquivos privados da VPS**, não
devem ser criados/versionados localmente. Manter permissão `0600` e nunca enviar
segredos por chat.

### Brevo / SMTP

Criar conta e remetente, autenticar o domínio e obter o login e a chave SMTP
(não a senha da conta nem a chave API). Preencher `/etc/radar/smtp.json` a partir
de `/etc/radar/smtp.json.example` com `smtp-relay.brevo.com`, porta 587,
STARTTLS e remetente aprovado. Validar conexão/autenticação sem envio com
`finalization/verify-smtp.mjs` em container descartável. Só depois configurar
app/worker e SMTP do realm. Não enviar e-mail de teste até confirmar o destinatário;
reset/recuperação e autorregistro Keycloak permanecem desativados até validação e
aprovação explícitas.

### Backblaze B2 / Restic

Criar bucket privado exclusivo e chave de aplicação limitada a esse bucket, com
permissões necessárias de leitura/escrita/listagem. Preencher
`/etc/radar/external-backup.json` a partir do `.example`, mantendo `0600`; não
habilitar `enabled: true` até preencher as credenciais (necessário para `init`/
`upload`). Guardar uma cópia privada de
`/etc/radar/restic-password` fora da VPS: sem ela o backup não pode ser restaurado.

Após credenciais e senha guardada externamente, executar `init`, `upload` e
`check` do `/root/radar-deploy/external-backup.py`; validar download e restauração
de um snapshot real antes de habilitar o timer externo. O timer segue desativado;
nenhum upload B2 foi feito, e acesso/restauração remotos não estão validados. O
Restic passou apenas validação offline de init/upload/check/restore, incluindo
rejeição de senha incorreta e snapshot adulterado. O teto conservador de 8 GB do
script não limita cobrança do B2: inspecionar uso do bucket e versões de objetos,
e configurar alertas de uso. A retenção 7 diários/4 semanais/3 mensais é apenas
`retention-preview`: revisar o relatório privado, sem aplicar exclusões. Não há
regra de ciclo de vida nem script que apague backups; não aplicar retenção.
