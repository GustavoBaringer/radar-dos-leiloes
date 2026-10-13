# Fixtures — Norte Leilões (norteleiloes.com.br)

Respostas reais da API `https://www.sistema.norteleiloes.com.br/lotes/listar-dados`,
capturadas em **2026-10-13T18:53–19:04Z** com POST `application/x-www-form-urlencoded`
(`pagina={N}&porPagina=12`) e headers `Origin: https://www.norteleiloes.com.br` /
`Referer: https://www.norteleiloes.com.br/lotes` (sem eles a API devolve 403 — medido).

| arquivo | requisição | itens | sha256 do corpo original |
|---|---|---|---|
| `page-1.json` | `pagina=1&porPagina=12` | 12 | `f7f3f31341972d5ce27f122eda614b7605a5a7ee2be58121065b2b434b5a9d7f` |
| `page-2.json` | `pagina=2&porPagina=12` | 12 | `0fe2d6baa40c086adddd6ad3811de9358a7fc5a32e8cabeb1c9f65eacd47dcce` |
| `filtro-lei-4435.json` | `pagina=1&porPagina=12&LEI_ID=4435` | 1 (repete o 74772 da página 1) | `97a994a80d922f7e113518c563f05318f9959aa4ba5ef41692f3bd75a515ad40` |
| `page-31.json` | `pagina=31&porPagina=12` | 4 (última página; total 364 / 31 páginas) | `8bb8a87a333470b26adb5406b8a22f64f3329373eeab8751ebde7ae3dc023bd5` |

Cada arquivo guarda metadados de proveniência: `url`, `method`, `requestBody`,
`requestHeaders`, `status`, `capturedAtUtc`, `originalBytes`,
`sha256OriginalBody` (hash do corpo ANTES da trunca) e `truncated` (lista do que
foi cortado para caber no repo):

- removidos: `comitentes`, `subcategorias`, `estadosConservacao`, `marcas`,
  `modelos`, `combustiveis`, `anosfab`, `cores`, `ufs`, `cidades`, `bairros`,
  `dadosInfoLeilao` (facetas de filtro, sem lotes);
- `fotos`: só as 2 primeiras entradas de cada lote (as demais removidas).

`dados`, `dadosPaginacao`, `total`, `leiloes` e `categorias` estão íntegros.
O filtro `LEI_ID=4435` prova o formato de filtro opcional no mesmo body e entrega
o lote 74772 que também está na página 1 — é a base do teste de dedup.
