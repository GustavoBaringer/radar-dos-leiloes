# Coleta explícita de domínios

`node --env-file=.env --import tsx scripts/collect-sites.ts` lista os 11 pares fonte/domínio revisados sem conectar a serviços.

- `--run <domínio|all> [--limit N]` coleta sequencialmente pelo mesmo executor limitado do worker.
- `--schedule` faz upsert apenas dos 11 agendadores próprios, mantendo outros agendadores Redis intactos.

Os tenants revisados usam timeout de 600s por padrão; `WORKER_SOURCE_TIMEOUTS_MS` substitui o orçamento por fonte. Limite e timeout são tetos operacionais, não garantia de catálogo completo: resultados são bounded e podem ser parciais.

**Não ativar `--schedule` até todos os consumidores da fila `collect` entenderem `tenant`.** Um worker antigo pode ignorar o campo e expandir a coleta para a fonte inteira. A execução manual não inicia consumer nem coleta ao listar; cada fonte ainda precisa estar habilitada e permitida por `WORKER_SOURCES`.
