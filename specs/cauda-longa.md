# Cauda longa — 4 conectores (medido com curl em 15/09/2026)

Ordem de implementação por lotes ganhos por hora: mega → frazao → parque → leiloesbrasil.

## 1. megaleiloes.com.br (single-site, padrão kuss.ts)

`GET https://www.megaleiloes.com.br/lotes-abertos?pagina=N` — 48/página, 17 páginas, 812 lotes.
Contador em `.summary`: "Exibindo 1 - 48 de 812 itens. Página 1 de 17".
Rotas por categoria também servem: `/veiculos?pagina=N` (86 itens), `/imoveis?pagina=N`.

Card: `div.col-sm-6.col-md-4.col-lg-3 > div.card` (não há classe de item estável).

| Campo | Extração |
|---|---|
| titleRaw | `.card-title` → `parseTitle()` |
| externalId | `.card-number` sem o `J`, ou `data-key` do wrapper |
| lotUrl | `href` de `.card-title`, **sem a querystring `utm_*`** |
| photos | `data-bg` de `.card-image` (é background, não `<img>`); `card-no-image-320x240.png` é placeholder → `[]` |
| assetType | **pelo prefixo do href** (`/imoveis/...` vs `/veiculos/...`), nunca pelo `<h5>` que às vezes é só "AUTOMÓVEL" |
| city/state | atributo `title="Cidade, UF"` de `.card-locality` (mais confiável que o texto) |
| minBid | `.card-instance-value` do `.instance.active` — é o mínimo da praça, **não** lance atual → `currentBid: null` |
| status | `.card-status`: "Aberto para lances" → aberto |
| closingModel | `pregao_em_horario`; data em `.instance.active .card-second-instance-date`, regex `/(\d{2}\/\d{2}\/\d{4})\s*às\s*(\d{2}):(\d{2})/`, BRT→UTC +3h |
| docType | link `/leiloes-judiciais` no card → judicial |

**Status HTTP é confiável aqui** (único dos quatro): slug errado com id certo → 301 canônico; id inexistente → 404 honesto.

**PII: não buscar a página de detalhe.** Ela traz `Autor` (credor) e `Réu` (pessoa física executada) em claro:
`<div class="forum item"><div class="header">Réu</div><div class="value">JUCIANE CRISTINA DA SILVA CABRAL</div></div>`.
A listagem já dá tudo que o produto precisa; o detalhe só acrescentaria incremento.

## 2. frazaoleiloes.com.br

`GET /Sale/LotListSearch?start=0&limit=100&loteAtivo=true` — apesar do nome, devolve **HTML**, não JSON.
Total no atributo do container: `<div id="leilao-lista-lote" total="505" limit="100">`. Paginar `start` de 100 em 100.

Item: `.card-format-all.thumbnail-vitrine-lot` — **não** use `#card-lote`, o id se repete no DOM.

| Campo | Extração |
|---|---|
| titleRaw | atributo `title` do `b` em `.lot-title-cap`. **Descartar lote com `[TESTE]`** |
| externalId | `data-lote-id` do `a.item-photo` |
| photos | `img` em `.photo-lot`; `lote_default.png` é placeholder → `[]` |
| minBid | `.price-line` do bloco "2º Leilão" (o vigente); se só houver 1º, esse |
| status | `status-green`→aberto, `status-gray`→encerrado, `status-red` ("LOTE RETIRADO")→encerrado + marcar em raw, `status-yellow` "AGUARDE LIBERAÇÃO"→agendado, "ENVIO DE PROPOSTA"→aberto |
| closingModel | `pregao_em_horario`; último bloco "Nº Leilão: DD/MM/AAAA às HHhMM", BRT→UTC |
| city/state | **null** — não está na listagem (2 em 100 cards) |
| sourceCategory | `.lot-info-cap .col-11` só quando bater rótulo conhecido; quando for endereço, passar `null` e deixar `classifyAsset(titleRaw)` decidir |

**Armadilha: 301 → home.** `GET /lote/99999999-nao-existe` redireciona para `/`; como o `fetchText` segue redirect, o resultado é 200 na home e o lote inexistente passa por sucesso.
Discriminador: o body do detalhe válido contém `data-lote-id="{id}"` com o mesmo id pedido.

**PII em claro no detalhe:** `placa EUX3004, Chassi 8BCLDRFJVBG546491, RENAVAM 00326224076` em texto livre → rodar `scrubPlates()` antes de qualquer persistência.

Volume: 505 lotes, ~97% imóvel. Fonte fraca para veículo.

## 3. parquedosleiloes.com.br — maior fonte de veículo do grupo

`GET /leiloes?is_lot=1&lot_status_id=2&type_id=1&page=N` — 12/página, 31 páginas, **372 veículos**.
`type_id`: 1=Veículos, 2=Bens, 3=Imóveis. Sem esse filtro a amostra mistura.
HTML server-rendered (Laravel), não precisa de JS.

**Armadilha grave: o texto do badge de status mente.** Medido: `lot_status_id=1` e `=2` renderizam "Cancelado" ou "Suspenso" no badge, inclusive na página de detalhe onde o JSON logo acima diz `"status_name":"Leilão aberto para lances"`. Os status 5 e 7 renderizam certo. **Nunca ler o texto do badge** — usar `data-lot-status-id` ou o JSON do detalhe.

JSON do detalhe em `GET /leilao/{leilaoId}/lote/{loteId}`, dentro de `<div data-json="auctionLot">`:
`{"id","started_at","ended_at","status_id","status_name","increment_value","min_bid_value","dateServer"}`.
É a única fonte de status, mínimo e incremento — nenhum deles está na listagem. Custo: ~403 requisições por ciclo (31 listagem + 372 detalhe), 6-7 min.

**`ended_at` é comprovadamente falso.** Um lote tinha `ended_at: 2026-09-03` com `dateServer: 2026-09-15` (12 dias no passado) e `status_name` ainda "aberto"; outro tinha `ended_at: 2025-03-31`. É soft-close por inatividade. → `closingModel: 'sequencial'`, `auctionStartUtc` = `started_at`, **`auctionEndUtc: null` sempre**.

Mapa de status: 1→agendado, 2→aberto, 3/4/6→aberto (rodadas de pregão), 5→aberto (presencial), 7→encerrado, 8→aberto (arrematação condicional).

Validação por conteúdo: exigir `data-json="auctionLot"` com `"id":{loteId}` batendo — id inexistente dá 302 para `/leiloes`, que vira 200 se seguir o redirect.

PII: não encontrada nas duas amostras (único dos quatro sem PII confirmada).

## 4. leiloesbrasil.com.br

POST de formulário, precisa de `PHPSESSID` obtido num `GET /veiculos/` antes:
```
POST /lotes/listar-dados
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
pagina=1&LET_ID=1&LEI_SITE_TIPO[]=PRESENCIAL-ONLINE&LEI_SITE_TIPO[]=PRESENCIAL&LEI_SITE_TIPO[]=ONLINE&LEI_SITE_TIPO[]=ELETRONICO
```
`LET_ID`: 1=Veículos, 2=Imóveis. Resposta JSON com `total`, `dados` (HTML de `<tr>`), `pagina`, e facetas (`marcas`, `modelos`, `anosfab`, `combustiveis`, `cores`).

**Armadilha: o checkbox `LET_ID_JUDICIAL=1` vem `checked` no HTML.** Reproduzir o formulário "como está" derruba o total de 40 para 1 — o site filtra em silêncio para só judicial. **Não enviar esse campo.** A chamada "funciona" (200, JSON válido) com 97,5% menos dados.

Marca, modelo, cor e ano vêm **em colunas separadas** — é a única fonte com atributo de veículo já estruturado. `externalId` = `data-rowid` da `<tr>`. `lotUrl` = `/veiculos/lote/{data-rowid}`.
`closingModel: 'sequencial'` (`js_situacaoLeilao` = `em_loteamento`), `auctionEndUtc: null`.
Coluna 6 é hora de **início da sessão**, compartilhada por todos os lotes do leilão.

**`currentBid`/`minBid` ficam `null`**: a listagem mostra "Faça o login" no lugar do valor, e o detalhe sem login também não traz. Só `<span id="incremento">` é público. Não contornar login.

Validação por conteúdo: id inexistente dá **200** com `<title>Detalhe do lote</title>` idêntico ao de um lote válido. Discriminador: presença de `id="VEI_PLACA"`.

**PII: a fonte já mascara** (`Placa: SC*-**89`, `Chassi: 8A9359******7767`) — o melhor dos quatro. Rodar o scrub mesmo assim.

Volume hoje: 40 veículos + 115 imóveis.

## Cadência
Testado 300ms e 700ms com 6 requisições nos quatro: todas 200, sem 429/503. Usar `gapMs: 1100` mesmo assim (regra fixa do projeto).
