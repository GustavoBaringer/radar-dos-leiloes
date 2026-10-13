# Coleta diária por domínio

`DAILY_TENANTS_ENABLED=1` ativa o consumidor `collect-daily-sites` dentro do worker existente.
`TENANT_LEDGER_ENABLED=1` habilita também o histórico dos conectores gerais. A fila diária
sempre exige histórico, independentemente dessa segunda variável.

O manifesto versionado `src/queue/daily-coverage.ts` preserva os 120 domínios atrasados
auditados em 13/10/2026 e inclui os sites solicitados de PE/SE/PB: 158 domínios únicos.
Cada domínio tem um agendador diário independente, distribuído entre 00:00 e 10:28
no horário de Brasília, uma tentativa por job e prazo de até 180 segundos. O consumidor
tem concorrência 1. Navegadores compartilham o portão de serialização do worker geral.

O limite é por domínio (1.200 lotes; Caixa 15.000), sem o teto global da coleta da
plataforma. Limite e prazo não garantem catálogo completo: o registro informa retorno,
descartes e estado parcial/falha. Uma execução vazia com HTTP 200 também deixa registro.
Erros antes do adapter iniciar, fontes desabilitadas e falhas de gravação são registrados
na tentativa e em `collection_runs.error`. URLs de outros domínios não são persistidas.
Coletas individuais não contam como atualização de toda a plataforma no descanso
do refresh de lotes próximos de encerrar; a agenda diária não adia os demais sites.

Ao iniciar, o worker repõe os domínios sem tentativa diária registrada naquele dia.
Essa recuperação inicial consulta até cinco lotes por site, com 45 segundos, para
registrar cobertura sem bloquear a fila diária por catálogos muito grandes. Os jobs
diários recorrentes mantêm os limites completos. Nenhuma notificação em massa é enviada
por essa fila de cobertura; os ciclos existentes de alertas permanecem independentes.

Domínios explicitamente marcados `monitorOnly` são consultados e registram falha com
motivo de falta de catálogo/adaptador revisado, em vez de retornar sucesso fictício.
Isso inclui endereços inexistentes, o erro de grafia Foco e o portal externo COMPREI.
Não se presume que um endereço de terceiro corresponda a outro leiloeiro.

Verificação operacional: cruzar o manifesto com `tenant_collection_attempts.domain`
e `job_id` começando por `daily-` ou `repeat:daily-site-`, e com `collection_runs.job`
igual a `collect:daily`. `completed` com `returned=0` significa tentativa sem lotes;
`failed` com `error_kind=budget` significa prazo excedido. Erros detalhados ficam no run.
Falha de infraestrutura pode impedir executar no horário; a recuperação na subida
registra os domínios pendentes. Não há garantia de sucesso contra sites indisponíveis.

O executor de deploy pausa, drena e restaura também a fila diária. Não remover as agendas
de fonte nem os 11 agendamentos antigos durante essa ativação.
