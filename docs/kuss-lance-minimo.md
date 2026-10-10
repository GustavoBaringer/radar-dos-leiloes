# Lance mínimo da Kuss

A listagem `json_edital.php` publica a oferta atual em `valor`, mas não traz o
lance inicial. O conector consulta também `json_lance_historico.php` via POST:
`leilaoID`, `le_id` estável, `loteado=S`, `seq=0`, `incr=0`, `sugestao=S`.
O campo `av` corresponde ao valor que a página identifica como Lance Inicial ou
Lance Mínimo. Usar `loteado=N` nessa consulta omite o valor, mesmo quando a
listagem exige N. `incr` é incremento; ofertas atuais não são lance mínimo.

A consulta respeita o intervalo de 900 ms e o cancelamento da coleta. Respostas
HTTP inválidas ou falhas de transporte interrompem a coleta antes do upsert.
Ausência de `av` mantém `minBid=null`. A resposta completa não é persistida,
pois pode conter identificadores dos licitantes.

Para revisar lotes já gravados, com DATABASE_URL configurado:

```sh
node --import tsx scripts/backfill-kuss-lance-minimo.ts
node --import tsx scripts/backfill-kuss-lance-minimo.ts --aplicar --backup=/caminho/kuss-before.json
```

A simulação não grava. A aplicação exige um arquivo novo de backup, consulta
primeiro todos os lotes Kuss sem lance mínimo e depois grava em uma transação.
Altera somente `min_bid` e `bid_suspect`. Identidade, oferta atual e avaliação
são conferidas novamente na gravação para evitar sobrescrever mudanças
concorrentes. IDs, favoritos, alertas e datas de descoberta são preservados.
Lotes sem identidade estável ou sem valor publicado ficam fora da atualização.

No worker controlado de produção, configurar `WORKER_SOURCE_TIMEOUTS_MS` com
`"kuss":600000`: a consulta por lote aumenta a duração da coleta completa.
Esse ajuste fica no runtime de implantação, separado do conector.

Validação: typecheck, build de backend, suíte isolada e coleta real limitada a
um lote. O mesmo módulo foi testado na imagem de produção antes de atualizar
somente o conector Kuss do worker.
