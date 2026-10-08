# Produção no Dokploy (template, ainda não ativado)

Este arquivo prepara configuração para uma VPS futura. Não executar nem testar
deploy nesta máquina empresarial. Operações de VPS ficam a cargo do usuário, no
navegador externo; não usar SSH, túneis, IPs/domínios reais ou credenciais locais.

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
   nunca versionar o arquivo preenchido. Senhas usadas dentro de URLs devem ser
   URL-safe (sem caracteres reservados); não se presume codificação automática.
    Definir TURNSTILE real para o hostname servido (não depende de Cloudflare DNS
    ou CDN), sessão, senhas e CIDRs estreitos. O ACK de proteção da origem deve
    permanecer vazio até verificação operacional independente; CIDRs precisam
    ser verificados, não preenchidos por suposição.
3. Antes de qualquer escrita pública, validar backup externo e um restore
   testado, com identidade de usuários preservada por `sub`/roles, sem merge por
   e-mail. Atualmente não há backup automatizado nem SMTP/recuperação de conta.
   Manter registro público e self-registration do Keycloak desabilitados no
   início; preparar canal de suporte/recuperação manual antes de abrir cadastro.

## Ordem de implantação controlada

1. A interpolação do Compose valida variáveis obrigatórias de todos os serviços,
   mesmo quando se selecionam serviços para iniciar. Para a fase de Postgres e
   Keycloak, forneça credenciais do Postgres, Redis e Keycloak, além de
   `KEYCLOAK_VERSION` como versão patch exata `26.x.y` revisada. Revise notas de
   release, segurança e migração antes de escolher a versão; não use `latest` nem
   atualize automaticamente. Os segredos exclusivos do `web` (sessão, Turnstile,
   CIDRs e ACK de origem) podem permanecer vazios nesta fase; isso só permite
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

Não há worker no stack padrão: jobs/coletas não executam. Projetar worker
separado somente com gate de recursos e execução operacional aprovados. Sem
SMTP não há promessa de recuperação de conta por e-mail; sem backup externo
testado não habilitar escrita pública.
