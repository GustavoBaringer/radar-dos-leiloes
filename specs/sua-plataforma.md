# Conector: Sua Plataforma de Leilão

> **CORREÇÃO 16/09/2026 — o contrato abaixo não reproduz mais.**
> O `POST /ApiEngine/GetBusca/{pagina}/0/0` responde hoje **HTTP 200 com corpo
> VAZIO** em todos os tenants testados (destak, gf, legis). Não é bloqueio: o
> endpoint aceita a requisição e devolve nada.
>
> **O que funciona é `POST /ApiEngine/GetLotes/{pagina}/{qtd}`** — o mesmo que a
> spec original havia descartado por lentidão. A lentidão foi contornada por um
> achado novo: **a listagem vem ordenada com os lotes ATIVOS primeiro**. Medido
> no destakleiloes (7.625 lotes no catálogo): página 1 só com aberto/aguardando,
> página 5 já toda arrematada, página 20 toda encerrada. Parar na primeira
> página sem nenhum ativo troca 39 requisições por tenant por 2 a 4.
>
> Outras divergências medidas hoje:
> - **`Cidade`/`UF` não existem no `GetLotes`** (nem no item, nem no
>   `GetLoteRealTime`). Só dá para extrair do título, quando o tenant usa o
>   padrão "Casa em Diadema/SP". Quem não usa fica sem localização — lacuna
>   declarada, não contornada.
> - O status vem de `GetLoteRealTime[0].Lote_SubStatus_Label`, com os rótulos
>   `Aberto para lance`, `Venda Direta`, `Aguardando início`, `Leilão
>   arrematado`, `Leilão suspenso`, `Leilão encerrado`.
> - `Lote` (o título) às vezes traz só o número do lote ("001") ou rótulo
>   interno ("SIMULADOR") — descartados na entrada.
>
> O que a spec original acertou e continua valendo: `externalId` é POR TENANT
> (prefixar com o host), os `ID_Categoria` não são estáveis entre tenants
> (filtrar por rótulo), `LabelModalidade` em vez dos booleans `IsJudicial`, o
> campo `Foto` já inclui a extensão, e a `Descricao` é onde mora a PII.
>
> Implementado em `src/connectors/suaplataforma.ts`.

---

# Levantamento original (medido com curl em 15/09/2026)

Híbrido de `vlance.ts` (API JSON, sem HTML) e `soleon.ts` (`externalId` por tenant). ASP.NET atrás de Cloudflare.

## Tenants
`discovered_sites` tem 44 domínios com `platform='sua-plataforma'`. Hoje **39 respondem**. Os 5 mortos:
- `apaleiloes.com.br` → 405; `casareisleiloesonline.com.br` → 404
- `tezaleiloes.com.br` → 404, mas é duplicata de `teza.com.br` (que funciona)
- `patricialeiloeira.com.br` e `wsleiloes.com.br` → 301 para a **home** de `pwleiloes.com.br` (não preservam o path)

`http_status=200` no `discovered_sites` **não basta** — tratar 4xx e redirect-para-home como tenant morto e seguir (`break`, como o vlance).
Hosts servem em `www.<domain>`; o domínio sem `www` dá 301 → resolver o host antes do POST (POST seguindo 301 degrada para GET).

## Endpoint — usar `GetBusca`, não `GetLotes`

```
POST /ApiEngine/GetBusca/{pagina}/0/0
{ SubStatus: [1,6,7,8], ID_Categoria: 0, QtdPorPagina: 9999, ... }
```
Medido: `GetLotes/1/9999` no maior tenant (legisleiloes, 14.264 lotes) **não terminou em 180s** (12,6 MB truncados); com 1000/página estourou 60s; e tenants médios (2.500-5.400 lotes) estouraram 30s com 2000/página. A frase "qtdPorPagina alto traz o catálogo inteiro" só vale para tenants pequenos.
`GetBusca` filtrado por status: **1 request por tenant, 4-17s**, e 95% do catálogo bruto que o `GetLotes` traria é `encerrado`/`vendido` que seria descartado.
Filtrar categoria **no cliente** (`ID_Categoria: 0` na chamada): um request substitui cinco, contagem conferida contra chamada filtrada isolada (130 veículos nos dois casos).
`GetBusca` ainda traz, que o `GetLotes` não traz: `Cidade`, `UF`, `Coordenadas`, `Lote_CEP`, `Lote_Endereco`, `Comissao`, `IsEncerrado`.

Custo total: ~39 requisições por ciclo.

## `externalId` é POR TENANT — contrário ao vlance
Prova: `ID_Leiloes_Lote=3691` existe em `amazonasleiloes.com.br`; `GetInfoLote/3691` em `legisleiloes.com.br` devolve `{"Lista":[]}`. Sequências independentes (legis chega a ~35000, amazonas a ~3600).
→ `externalId = \`${host}:${l.ID_Leiloes_Lote}\`` (padrão soleon). Sem o prefixo, tenants diferentes colidiriam na `UNIQUE(source_id, external_id)` e um sobrescreveria o outro em silêncio.

## Filtro de categoria — correção ao contrato
IDs conhecidos: 55=Residenciais, 58=Terrenos, 61=Comerciais, 62=Industriais, 65=Veículos, 72=Diversos.
**Não são estáveis entre tenants**: `destakleiloes.com.br` usa `ID_Categoria=85` com o rótulo "Residenciais" (241 lotes de imóvel).
**Não caia no fallback de `classifyAsset()`** — ele termina em `{ assetType: 'veiculo', vehicleType: 'carro' }`, o que classificaria 72/85/86/93 como veículo.
Filtro dedicado: id conhecido **ou** rótulo (`l.Categoria` com `fold()`) batendo `/resid|terreno|comerc|industri/` → imóvel, `/ve[ií]cul/` → veículo. **Descartar** o que não bater em nenhum grupo.

## SubStatus → status canônico
| código | rótulo | canônico |
|---|---|---|
| 1 | Aberto para lance | aberto |
| 2 | Leilão suspenso | encerrado (não há `suspenso` no enum) |
| 5 | Arrematado | vendido |
| 6 | Aguardando início | agendado |
| 7 | Aguardando datas | sem_data |
| 8 | não observado em ~1.100 lotes | agendado, guardando o código em `raw.subStatus` |
| 9 | Venda Direta | aberto |

## Campos
- `lotUrl` = `https://${host}/${URLlote}` (já vem sem barra inicial)
- `docType` = `LabelModalidade` dobrado. **Não usar os booleans `IsJudicial`/`IsExtraJudicial`** — medido lote com `LabelModalidade="Extrajudicial"` e os dois booleans `false`
- `auctionEndUtc` = `DataHoraEncerramento{Primeira,Segunda,Terceira}Praca` escolhido por `GetLoteRealTime[0].PracaAtual`. Não fixar sempre a segunda praça
- `closingModel: 'timer_por_lote'`, `sourceTz: 'America/Sao_Paulo'`
- lances: `GetLoteRealTime[0]`.`ValorLanceAtual`/`ProximoLance`/`ValorIncremento`/`Comissao`
- `sellerName` = `Comitente` (comitente ≠ leiloeiro; a fonte não identifica o leiloeiro)
- `photos` = `https://${host}/imagens/1200x1200/${Foto}` — **o campo `Foto` já inclui a extensão**, não concatenar `.jpg`. Testados 555x382, 800x600 e 1200x1200: 200 + image/jpeg
- `km`/`color`/`fuel`/`plateMasked`: **null** — só existem em texto livre na `Descricao`, que exigiria `GetInfoLote` por lote
- `raw`: o objeto do lote **sem a `Descricao`** — é onde mora a PII

## Validação da URL do lote
Lote inexistente devolve **200** nos dois tenants testados. `dg-lote-titulo` às vezes sobrevive na casca e **não discrimina**.
Único marcador confiável: `<input name="ID_Leiloes_Lote" value="{id}">` presente com o id pedido.

## LGPD — padrões novos, não cobertos pelo código atual
`scrubPlates()` cobre placa, chassi, RENAVAM e nº de motor. **Não há cobertura de CPF, CNPJ nem nome de parte** em lugar nenhum do repo (só a função local `semPartesJudiciais()` do soleon).

Confirmado em claro nesta fonte:
- `"Fiel depositário: Melquesedeque Mascarenhas Ferreira, CPF/MF 0X.XXX.XXX-XX"` (amazonasleiloes, lote 3691)
- `"RQTE: VAGNER ROGÉRIO MENDES RQDO: STILLUS HORSE ARTEFATOS EM COURO LTDA"` (legisleiloes) — rótulos **abreviados** que o `semPartesJudiciais()` não cobre
- `"Renavam 00685458458"` em claro **no mesmo lote** em que a fonte já mascarou a placa (`"Placa B***4"`) — a fonte mascara placa e nada mais
- `"Segundo a Sra. Vanessa, o veículo foi financiado"` — nome solto fora de rótulo, **risco residual sem regex possível**; documentar, não tentar NER

A implementar: CPF `\d{2,3}\.?\d{3}\.?\d{3}[-/]?\d{2}`, CNPJ, `RQTE|RQDO` na regex de rótulos, e `/(fiel\s+deposit[áa]rio\s*:?\s*)([^,]+),?\s*CPF/i`.
**Nunca mapear os campos estruturados `Autor`/`Reu`** do `GetBusca` — hoje vêm vazios, mas se a fonte popular, entrariam sem passar pelo scrub porque são JSON, não HTML.

## Volume medido (39 tenants, uma chamada cada)
| Filtro | Veículo | Imóvel | Total ativos |
|---|---|---|---|
| SubStatus [1,6,7,8] | **296** | **939** | 1.805 |
| SubStatus [1] | 92 | 464 | 785 |

`legisleiloes` sozinho: 130 veículos e 102 imóveis ativos, de um catálogo histórico de 14.264. `destakleiloes`: 43 e 94. 15 dos 39 tenants sem lote ativo.

Env var `SUAPLATAFORMA_TENANTS` (padrão 40), `gapMs: 1100`. `refresh()` não é necessário — não há endpoint de lance avulso.
