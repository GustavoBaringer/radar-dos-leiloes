# Tarefa: conector da plataforma Leilão PRO

Implemente `src/connectors/leilaopro.ts` e registre em `src/connectors/index.ts`.

## Modelo a seguir
Leia **`src/connectors/soleon.ts` inteiro antes de começar** e siga a mesma estrutura:
é o conector irmão, também multi-tenant e também HTML com cheerio. Copie o padrão de
`Connector`, `CollectResult` e `CanonicalLot`. Não invente estrutura nova.

## O que já foi medido (não precisa re-descobrir)
- Marcador da plataforma no HTML: `leilao.pro`.
- Rotas de listagem por categoria, no domínio de cada tenant:
  - `/leilao/lotes/veiculos`  → `assetType: 'veiculo'`
  - `/leilao/lotes/imoveis`   → `assetType: 'imovel'`
  - `/leilao/lotes/maquinas`  → `assetType: 'veiculo'`, `sourceGroup: 'maquina'`
- URL do lote: `/leilao/{slug-do-leilao}/lote_id/{id}` — o `{id}` numérico final é o
  identificador. Exemplo real:
  `/leilao/leilao-de-toyota-corolla-xei-2015-08-09-2026-12-17-53/lote_id/9552`
- Tenants confirmados para testar: `grandesleiloes.com.br`, `renovarleiloes.com.br`,
  `zuccalmaglioleiloes.com.br`, `deluccaleiloes.com.br`, `scheidleiloes.com.br`.

## Lista de tenants
Sai do banco, igual ao soleon.ts faz:
```sql
SELECT domain FROM discovered_sites
 WHERE platform = 'leilao-pro' AND http_status = 200 AND has_lots IS NOT FALSE
 ORDER BY auctioneers DESC LIMIT $1
```
Quantidade controlada por `process.env.LEILAOPRO_TENANTS` (padrão 12).

## O que você precisa descobrir
Os seletores CSS do card de lote e os campos disponíveis. Baixe uma página de listagem
com curl, leia o HTML e escreva o parser. Extraia o que existir:
título/descrição, número do lote, lance atual ou inicial, status, cidade/UF, foto, ano.

## Regras do projeto (obrigatórias)
1. **Nunca** grave dado pessoal: placa em claro, chassi, RENAVAM, número de motor, CPF,
   nome de executado/exequente. Se aparecerem no texto, remova o bloco judicial antes de
   o texto virar título — veja `semPartesJudiciais()` em soleon.ts. O scrub central já
   mascara placa/chassi/RENAVAM, mas nomes de pessoa você tem de remover.
2. `closingModel` só pode ser `'timer_por_lote'`, `'pregao_em_horario'` ou `'sequencial'`.
   Se a fonte não publica encerramento por lote, use `'sequencial'` e deixe
   `auctionEndUtc: null`. **Não invente data.**
3. Datas sempre em UTC, com `sourceTz: 'America/Sao_Paulo'`.
4. `externalId` deve ser único entre tenants: use `` `${host}:${idDoLote}` ``.
5. Cadência: 1 requisição por segundo por host. Use `fetchText` de `./http.js` com
   `gapMs: 1100`. Não paralelize dentro do mesmo host.
6. Comentário no código só quando explicar uma armadilha ou uma decisão. Não narre o óbvio.
7. Escreva em português nos comentários, como o resto do projeto.

## Como validar (faça isto, não pule)
```bash
npx tsc --noEmit
node --env-file=.env node_modules/.bin/tsx scripts/collect.ts leilaopro 60
docker exec leilao-db psql -U leilao -d leilao -c "SELECT left(title_raw,44), brand, city, state, min_bid, current_bid FROM lots WHERE source_id='leilaopro' LIMIT 8;"
```
O conector só está pronto quando: `tsc` passa, a coleta grava lotes, e a amostra mostra
título com descrição de verdade (não só uma categoria como "VEÍCULO"), e cidade/UF
preenchidos na maioria.

Ao terminar, escreva um resumo em `specs/leilaopro-resultado.md` com: quantos lotes
coletou, de quantos tenants, quais campos ficaram vazios e por quê, e quais armadilhas
você encontrou no HTML.
