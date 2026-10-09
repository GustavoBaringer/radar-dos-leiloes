# Brevo e Backblaze B2 — configuração pendente de credenciais

Escolha confirmada pelo usuário em 2026-10-09. Nenhuma conta paga foi criada.
Este guia está versionado na raiz do projeto. Todos os caminhos /etc/radar e
/root/radar-deploy mencionados abaixo são arquivos da VPS em produção.

## Brevo

1. Criar a conta gratuita e habilitar envio transacional. Cadastrar um remetente
   e autenticar `radardeleiloes.app.br` com os registros DNS fornecidos pelo Brevo.
2. Na área SMTP, obter o **login SMTP** e gerar uma **chave SMTP** (diferente da
   senha da conta e da chave API).
3. Copiar `/etc/radar/smtp.json.example` para `/etc/radar/smtp.json`, preencher
   `user`, `password` e um `from` aprovado no Brevo; manter permissão 0600.
   Servidor `smtp-relay.brevo.com`, porta 587, STARTTLS obrigatório.

Após receber o arquivo, validar conexão/autenticação com
`finalization/verify-smtp.mjs` em um container descartável com a imagem web,
o script montado em `/app/verify-smtp.mjs` e o JSON em `/ops/smtp.json`.
Esse teste não envia e-mails. Configurar depois os ambientes do app/worker e
o SMTP do realm Keycloak; só habilitar recuperação após validação completa.
Confirmar destinatário antes de enviar e-mail real de teste. Cadastro de contas
continua sujeito ao fluxo de produto; não habilitar autorregistro por acidente.

Documentação oficial:
https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP

## Backblaze B2

1. Criar a conta B2 e um bucket **privado**, exclusivo dos backups do Radar.
   Sem regra de ciclo de vida que apague objetos: restic controla os snapshots.
2. Criar uma Application Key restrita a esse bucket, com leitura/escrita e
   listagem necessárias ao cliente S3. Anotar `keyID`, `applicationKey` e o
   endpoint S3 da região do bucket. Não usar a chave principal da conta.
3. Copiar `/etc/radar/external-backup.json.example` para
   `/etc/radar/external-backup.json`, preencher as credenciais, bucket e região;
   exemplo de formato: `s3:https://s3.REGIAO.backblazeb2.com/BUCKET/radar`.
   Somente após preencher, mudar `enabled` para `true`. Manter permissão 0600.
4. Salvar uma cópia privada de `/etc/radar/restic-password` fora da VPS,
   por exemplo no gerenciador de senhas do celular. Essa é a chave de
   criptografia: sem ela, não há restauração dos backups restic.

Com credenciais prontas e chave guardada fora da VPS:

```sh
python3 /root/radar-deploy/external-backup.py init
python3 /root/radar-deploy/external-backup.py upload
python3 /root/radar-deploy/external-backup.py check
```

Validar download/restauração real de um snapshot externo antes de concluir o
item de backup externo e habilitar `radar-external-backup.timer`. O timer está
instalado, **desativado**, previsto para 07:00 UTC (04:00 São Paulo), após o
backup local diário das 06:30 UTC. A ação upload verifica SHA256SUMS, criptografa
com restic e verifica a estrutura do repositório. A ação check lê todos os dados.
Relatório privado em `finalization/external-backup/last-upload.json`.

O teto conservador de 8 GB evita novos uploads quando o tamanho dos dados restic
mais margem do snapshot excede esse valor. Não é uma trava de cobrança da conta
B2: conferir o uso real do bucket, versões de objetos e outros buckets no painel.
Configurar alertas de uso no B2. Nenhum backup local ou remoto é apagado pelo script.
Retenção proposta 7 diários/4 semanais/3 mensais somente em `retention-preview`;
o relatório fica privado e a aplicação de exclusões ainda depende de revisão.

Teste local com repositório criptografado: init/upload/check/restore passaram;
senha incorreta e snapshot adulterado foram recusados. Evidência:
`finalization/restic-offline-test.json`. Isso ainda não valida acesso ao B2.

Documentação oficial:
https://www.backblaze.com/docs/cloud-storage-application-keys
https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html

Não enviar credenciais por chat. Avisar apenas quando os arquivos estiverem
preenchidos; o agente lê esses arquivos privados sem imprimir os segredos.
