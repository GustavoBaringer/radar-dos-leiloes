# Proxy de imagens e publicação da main

**Decisão temporária de 2026-10-12 (dono do projeto): o proxy fica sem limite
de requisições.** Nem cota por minuto — já removida em `c6dd64d`, que apagou as
políticas `image` e `imageMiss` — nem teto de concorrência. No servidor,
`runMiss()` parou de competir pelo orçamento de quatro leituras e
`tryAcquireImageJob()` concede sempre (`src/core/antibot/resources.ts`,
`src/core/antibot/images.ts`); no navegador, os cartões deixaram de carregar em
pares e pedem as fotos de uma vez (`app-busca/src/lib/image-queue.ts`).

Continuam valendo: allowlist de hosts derivada dos lotes, validação de raster,
download de até 20 MiB, prazo de 15 segundos, cache em memória limitado e as
retentativas com espera do cartão. As outras rotas da API seguem com o teto de
quatro leituras — ele não é do proxy de imagens.

Não existe mais caminho que devolva 503/429 por quantidade de imagens: o único
503 possível vem de `acquireDegradedWork()`, que só corta em `ANTIBOT_MODE=enforce`
com o Redis degradado. O preço conhecido é saturação de CPU/memória do sharp sem
backpressure. Antes de virar permanente, conferir `images` em
`/api/security/metrics`. Para reverter, restaurar `IMAGE_LIMIT = 2` com o
semáfora em `resources.ts`, a lease de leitura em `runMiss()` e o limite 2 da
fila do navegador.

Administradores consultam `/api/security/metrics`: `images` contém volume,
picos por minuto e por cliente, cache, falhas, sobrecarga e tempos de resposta.
As janelas são minutos UTC do calendário. Picos por cliente usam um mapa em
memória limitado a 10 mil clientes/minuto, com contador de entradas omitidas.
Nenhum IP, conta ou URL é gravado nos resumos.

`IMAGE_METRICS_DIR` habilita arquivos JSONL diários de agregados, mantidos por
90 dias em um diretório persistente. Totais do endpoint reiniciam com o processo;
os arquivos conservam o histórico para análise depois de reinícios/deploys.
Resumos também aparecem como `[images.minute]` nos logs do serviço. Cache do
navegador não faz requisição ao proxy e não entra nessas métricas.

## Dokploy

No campo Command do Dokploy, configurar (o painel acrescenta `docker` no início):

```sh
exec radar-deploy-runner flock -w 1800 /etc/dokploy/radar-runtime/deploy-main.lock node /etc/dokploy/compose/radar-stack-m9wohj/code/infra/dokploy/deploy-main.mjs
```

O executor valida um único comando Docker: `exec` executa o script no container
`radar-deploy-runner`, que tem Node, Git, Docker CLI e flock. Esse container usa
`deploy-runner.yml`, sem portas e conectado somente à rede de saída para baixar
as imagens base. Usa os diretórios do Dokploy e socket
Docker necessários à publicação. Para execução manual, acrescentar `docker`
antes de `exec`.
O Dokploy clona a main antes de executar o comando. O script verifica a revisão,
exporta os arquivos desse commit (independente do Compose modificado pelo painel),
constrói web e worker com a revisão nas labels, testa a web candidata e só então
altera as imagens do runtime. Banco, Redis, Keycloak e relay são preservados.
Configurações existentes do worker passam a estar versionadas, incluindo prazo
e limites por fonte, serialização e prontidão. O worker contém Chromium.

A publicação pausa e drena as filas, preserva pausas prévias e retoma as demais.
Confere saúde e revisão dos dois containers. Em falha de ativação, restaura os
arquivos e imagens anteriores. Preserva a opção de deploy automático do Dokploy,
já habilitada nesta instalação. Evidências e arquivos
para rollback ficam em `/etc/dokploy/radar-runtime/releases/<commit>/`.
