# Coleta explícita de domínios

`node --env-file=.env --import tsx scripts/collect-sites.ts` lista os pares executáveis e os 20 domínios solicitados sem abrir DB, Redis ou filas. Atualmente há 19 pares executáveis na união de 29; 10 domínios seguem pendentes de contrato/sonda e `--run all`/`--schedule` recusam escopo incompleto.

- `--run <domínio|all> [--limit N]` usa o executor compartilhado; cada fonte precisa estar habilitada e permitida por `WORKER_SOURCES`.
- `--schedule` faz upsert somente na fila dedicada `collect-tenant`.
- Migração opcional: `--schedule --migrate-legacy /tmp/opencode/radar-cobertura-20/before.json` exige o snapshot exato de 59 schedulers, registra a fila dedicada primeiro e remove somente os 11 IDs tenant antigos da fila `collect`; os 48 schedulers de fonte permanecem intactos.

Timeout padrão: 600s por tenant; `WORKER_SOURCE_TIMEOUTS_MS` pode reduzi-lo. Limite e timeout são tetos, não promessa de catálogo completo.

O consumidor novo é `src/queue/tenant-worker.ts`: fila dedicada, validação do par antes da rede, consulta `sources.enabled`, limite de 1.200 lotes e timeout máximo de 600s. Ele não consome a fila `collect`.

Para supervisão futura, copie `ops/systemd/radar-tenant-worker.service.template` para a unidade systemd do usuário e substitua `@SERVICE_USER@`, `@RADAR_REPO_ROOT@` e `@NODE_ABSOLUTE_PATH@`. Após aprovação da ativação: `systemctl --user daemon-reload`, `systemctl --user enable --now radar-tenant-worker.service`, `systemctl --user status radar-tenant-worker.service`. Esta unidade não foi instalada nem ativada. Confirme user lingering antes de depender dela após logout.
