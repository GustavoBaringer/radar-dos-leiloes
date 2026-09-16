# Conector: Suporte Leilões

> **Status: v1 implementada** em `src/connectors/suporteleiloes.ts` (89 dos 107 domínios).
> A v2 (Next.js/RSC, 2 domínios) fica pendente: o parser do protocolo Flight não se
> paga por 2 tenants enquanto a v1 cobre 83% deles.
>
> **Correções ao levantamento, medidas na implementação:**
> - **Cidade e UF ESTÃO no card**, em `.r2 span` no formato "Barão de Cocais - MG".
>   A spec dizia que só apareciam no detalhe. Presentes em ~13% dos cards.
> - O container do card é `div.lote-main`, e ele carrega id e status nas próprias
>   classes (`bem-index-{id}`, `lote-main-status-{n}`) — mais estável que a ordem
>   dos elementos internos.
> - Lance inicial em `.r4 strong.reset-colorGrid`, lance atual em `.r4 strong.valor-grid`
>   (vem com texto "-" quando não há lance — sem tratar, vira 0).
> - A foto do CDN responde **301** e só resolve seguindo o redirect.
> - O título do card é longo e às vezes começa com aviso comercial
>   ("Sem Prazo Para Desvinculação - Veículo conservado - GM CLASSIC LS 2011/2012"),
>   mas marca e modelo estão lá e o classificador acerta.

---

# Conector: Suporte Leilões (medido com curl em 16/09/2026)

White-label multi-tenant como soleon/vlance/sua-plataforma, mas com uma complicação que nenhuma das outras três tem:
**duas gerações de front-end coexistindo no mesmo backend**, identificáveis por assinatura de build, servindo os mesmos dados por rotas diferentes.

## Tenants — a query do platform NÃO é o universo real de tenants

`discovered_sites` tem 107 domínios com `platform='suporte-leiloes'`, 82 com `has_lots=true`. O regex de descoberta
(`src/core/descoberta.ts:114`) é `/suporteleiloes|\.leilao\.br/i` testado contra o HTML da home — e **`\.leilao\.br` é um
sufixo de domínio genérico, não exclusivo da Suporte Leilões**. Reclassifiquei os 82 `has_lots=true` batendo a home de
cada um contra a assinatura real da plataforma (`static.suporteleiloes.com.br` no HTML, ou o build hash `/build/app.*.js`
idêntico entre tenants — comando: `curl -sA "<UA de navegador>" https://$dominio/ | grep -o 'static.suporteleiloes.com.br\|suporteleiloes'`):

| Classificação | Contagem | Exemplos |
|---|---|---|
| Genuíno, arquitetura v1 (Laravel) | 74 | liderleiloes, rodrigoleiloeiro, vecchileiloes, saraivaleiloes |
| Genuíno, arquitetura v2 (Next.js) | 2 | marcoantonioleiloeiro.com.br, vixleiloes.com.br |
| Genuíno, sinal só de texto (não bati o build hash) | 1 | rogeriomenezes.com.br (tem `suporteleiloes` no HTML, mas não usa o padrão de build que testei) |
| **Falso positivo — outra plataforma** | 5 | **`superbid.net`** (é a Superbid de verdade, já tem conector `src/connectors/superbid.ts`; pegou o platform tag por texto coincidente numa home dinâmica, hoje o HTML dela não bate nem `suporteleiloes` nem `\.leilao\.br`), `mercadoleiloes.com.br` e `confiancaleiloes.leilao.br` (WordPress/Elementor), `e-leiloeiro.leilao.br` (WordPress), `magalhaesleiloes.com.br` (redireciona para um 3º spelling do domínio, sem assinatura) |

**Não usar `WHERE platform='suporte-leiloes' AND has_lots` cru como lista de tenants.** Validar a assinatura (`static.suporteleiloes.com.br`
ou `suporteleiloes` no corpo da home) antes de tratar o domínio como tenant — do contrário o conector desperdiça ciclos em
`superbid.net` (que já tem conector dedicado, e devolveria dados duplicados/mal mapeados) e nas páginas WordPress.

Fora do universo `has_lots=true`: 3 domínios mortos (timeout/DNS: `gustavoleiloeiro.lel.br`, `clic.leilao.br`, `magalhaes.leilao.br`)
e ~14 tenants genuínos sem lote confirmado no momento — inclusive dentre os que respondem 200 com a assinatura certa, vários
mostram "Em breve" (`ricardogomesleiloes.com.br`, `leiloesja.com.br`, `portellaleiloes.com.br`, `wermelingerleiloes.com.br`,
medido: menu de categorias do `/buscador` fica **vazio** quando o tenant não tem nenhum lote ativo em nenhuma categoria —
não é erro, é o cardápio dinâmico escondendo o que está zerado).

## Duas arquiteturas, um backend só

Classificação por assinatura em todos os 107 domínios (`curl` na home de cada, sem seguir redirect cross-domain, 1
req/host): **89 são v1 (Laravel)**, **2 são v2 (Next.js)** — o resto é ruído (dead/falso-positivo, ver acima).

- **v1 (Laravel)** — assets em `/build/app.{hash}.js`, mesmo hash de arquivo **idêntico** em tenants diferentes
  (`app.c60458b6.js` está em `rodrigoleiloeiro.com.br`, `vecchileiloes.com.br` e `liderleiloes.com.br` ao mesmo tempo —
  é o mesmo arquivo, não coincidência de build tool). URL do lote: `/eventos/leilao/{slug-do-leilão}/lote/{id}/{qualquer-coisa}`.
- **v2 (Next.js/RSC)** — headers `vary: rsc, next-router-state-tree`, cookie `tenant_id` setado pelo servidor, chunks em
  `/_next/static/chunks/`. URL do lote: `/lotes/{id}` (sem slug). CDN de imagem **é o mesmo** `static.suporteleiloes.com.br`
  dos tenants v1, com o slug do tenant no path (`static.suporteleiloes.com.br/marcoantonioleiloeirocombr/bens/...`) —
  prova de que é a mesma base de dados por trás das duas gerações de site, não uma migração que separou os catálogos.

Prova direta de que é o mesmo backend: o card de `rodrigoleiloeiro.com.br` (v1) para o lote 10669 tem o link de
compartilhamento apontando para `https://marcoantonioleiloeiro.com.br/eventos/...lote/10669/lote` (v2 doesn't even use
that path, mas o v1 aceita), e **`GET https://rodrigoleiloeiro.com.br/eventos/leilao/.../lote/10669/lote` devolve HTTP 200
com o conteúdo do lote da Marco Antônio Leiloeiro** (`<title>Lote - Rodrigo Oliveira</title>` mas o corpo é
"MOTOCICLE HONDA / NXR125 BROS KS", `leilao.leiloeiro.nome: "Marco Antônio Barbosa de Oliveira Jr."` dentro do JSON —
ver seção `externalId` abaixo).

A v1 responde por **83% dos domínios genuínos** — é nela que o volume mora. A v2 é a geração nova, só 2 tenants achados,
mas provavelmente é a direção que a plataforma está migrando (Next.js SSR, `sitemap.xml` de verdade, robots.txt customizado).
O conector precisa **ramificar por arquitetura** (checar a assinatura antes de escolher a rota de coleta).

## API JSON ou HTML?

**Nenhuma API pública sem autenticação.** Existe `api-v2.suporteleiloes.com.br` (CORS liberado, headers customizados
`x-portal-cliente`/`uloc-mi` visíveis no preflight) — mas `GET /api/lotes` nela devolve **HTTP 401**
`{"detail":"Not privileged to request the resource."}` mesmo com `Referer`/`Origin` do tenant certo. Não persegui login/API
key: o robots.txt da v2 já desaconselha (`Disallow: /api/`), e o caminho abaixo (HTML com JSON embutido) dá o mesmo dado
sem autenticação.

**As duas arquiteturas embutem um blob JSON completo no HTML do detalhe** — método `json-embedded` (o enum já existe em
`src/core/types.ts`), não é scraping de texto solto:

- **v1**: `<script>var lote = {...};</script>` — JS válido, `JSON.parse` direto funciona (o PHP already faz
  `json_encode`, inclusive escapando `/` como `\/`, mas isso é JSON válido).
- **v2**: dentro de `self.__next_f.push([1,"12:[...,{\"initialLote\":{...}}]\n"])` — é o payload do React Server
  Components (protocolo "Flight"), **não é JSON puro** (tem marcadores tipo `$undefined`, `$L2e`). Estratégia que
  funcionou: achar o `push([1,"` mais próximo antes da primeira ocorrência de `initialLote`, ler até a aspa de
  fechamento **não escapada** (respeitando `\"` como par), `JSON.parse` essa string inteira (ela decodifica pra texto
  plano), aí dentro do texto plano procurar `"initialLote":{` e fazer bracket-matching simples, trocando
  `"$undefined"` por `null` antes do `JSON.parse` final. Script de prova em Python usado nesta medição, mesma lógica
  que o conector TS replica.

## Como listar os lotes ativos de um tenant

### v1 (Laravel) — `/buscador?categoria={1|2}&page={N}`
```
GET /buscador?categoria=1&page=1     (1 = Veículos)
GET /buscador?categoria=2&page=1     (2 = Imóveis)
```
Confirmado **idêntico em 6 de 6 tenants** que tinham a categoria populada (liderleiloes, rodrigoleiloeiro, vecchileiloes,
saraivaleiloes, facanhaleiloes, ibecleiloes) — mas o precedente da `sua-plataforma` (onde `ID_Categoria` variava por
tenant) pede cautela: **não hardcodar sem checar o rótulo**. O rótulo vem no próprio menu:
`<a href="/buscador?categoria=1">Veículos`. Quando a categoria está vazia (zero lotes ativos), o link **some do menu**
mas a rota continua respondendo 200 com 0 cards — dá pra chamar direto sem depender do menu.

12 cards por página. Última página vem no link `.default-pagination .double-right a[href*=page=]` — se não existir
esse elemento, é página única. Sem esse marcador, paginar às cegas arrisca martelar página vazia (a rota não dá erro
em página além do fim, só devolve 0 cards — testado, não travou, mas desperdiça requests).

**Custo por tenant**: `ceil(veículos/12) + ceil(imóveis/12)`, mínimo 2 (as duas categorias, mesmo vazias). Medido em 10
tenants (soma): 63 requisições para 545 lotes ativos — média 6,3 req/tenant. Extrapolado para ~75 tenants v1 genuínos:
**~470 requisições por ciclo completo**.

O card em si dá: id, URL, foto (uma), preço (lance inicial/atual), status (classe CSS), e um `<h3>` que **é a categoria,
não o título** — mesma armadilha do soleon (`h5` = "CAMINHONETE"/"AUTOMÓVEL"); o título de verdade
("MOTOCICLE HONDA / NXR125 BROS KS | 2003/2003 | AZUL") está no parágrafo de descrição dentro de `.reset-grid`.
Cidade/UF, comitente, leiloeiro, processo e a maior parte da PII **não aparecem no card** — só no detalhe.

### v1 (Laravel) — detalhe rico, opcional, 1 req/lote
`GET` na URL do card (`/eventos/leilao/{qualquer-slug}/lote/{id}/{qualquer-coisa}` — **o slug não é validado**, só o
id numérico importa, testado com slug errado em lote existente → HTTP 200 normal). O `var lote = {...}` do detalhe traz
tudo que falta no card: `leilao.leiloeiro.nome`, `leilao.data1/data2/data3` + `praca`, `comitente` (dentro de
`leilao.comitentes` — não confirmado neste blob específico, ver nota abaixo), localização, descrição completa, e
**histórico de lances com IP do licitante** (ver seção PII — motivo para nunca persistir esse bloco inteiro).

### v2 (Next.js) — `sitemap.xml` + página do leilão (bulk, não por lote)
```
GET /sitemap.xml                         → lista /lotes/{id} (só os NÃO encerrados) e /leiloes/{id}
GET /leiloes/{id}                        → JSON embutido com o leilão INTEIRO: metadados + `initialLotes.result[]`
                                            com TODOS os lotes do leilão (testado: 41 lotes em 1 request)
```
Achado importante: a página de **leilão** (evento) traz o **array completo de lotes** embutido (`initialLotes.result`),
não só o leilão. Isso muda o custo: em vez de 1 request por lote, é 1 request por **leilão** (evento), que devolve
dezenas de lotes de uma vez. `sitemap.xml` do `marcoantonioleiloeiro.com.br` listou **57** URLs `/leiloes/{id}` e
**205** URLs `/lotes/{id}` (só os não encerrados — o lote 10669, já "Vendido", não aparece na seção `/lotes/`).
Custo por tenant: 1 (sitemap) + número de leilões ativos — medido 58 para o maior tenant v2. Como só há 2 tenants v2
confirmados, o custo agregado dessa arquitetura é irrelevante perto da v1 (~116 requisições no total, contra ~470 da v1).

`vixleiloes.com.br` (o outro tenant v2) não tinha `initialLotes` na página de leilão testada (`/leiloes/369-...`) —
sitemap indisponível/formato de URL levemente diferente (`{id}-{slug}` em vez de `{id}` puro). Marcar como **não medido
totalmente**; o padrão confirmado é o do `marcoantonioleiloeiro.com.br`.

## `externalId` é GLOBAL — evidência direta, não só ausência de colisão

Testado exatamente como o método pede: peguei um id em um tenant e consultei o mesmo id em outro.

**Prova positiva (o caso que importa):** o lote `10669` pertence à Marco Antônio Leiloeiro (v2). Pedindo esse MESMO id
numérico em `rodrigoleiloeiro.com.br` (tenant v1, totalmente diferente), pela rota v1
(`/eventos/leilao/qualquer-coisa/lote/10669/x`), devolve **HTTP 200 com o mesmo lote**: mesmo título ("MOTOCICLE HONDA
/ NXR125 BROS KS"), mesmo `leilao.codigo` ("246/2026"), mesmo `leilao.leiloeiro.nome` ("Marco Antônio Barbosa de
Oliveira Jr."). Não é coincidência de numeração — é o mesmo registro, servido por outro front-end.

**Teste negativo controlado:** peguei um id nativo de `liderleiloes.com.br` (lote `29800`, Fiat Doblo, confirmado no
card do próprio tenant) e pedi em `leiloesja.com.br` (outro tenant v1). Resultado: **HTTP 404**, não um lote diferente
sob o mesmo id. Confirmei que não é o slug incorreto causando o 404 (testei slug errado + id 29800 **no próprio
liderleiloes** → HTTP 200 normal, a rota não valida slug). Ou seja: **nunca observei colisão** — um id numérico ou
resolve para o registro certo (quando o tenant está "vinculado" àquele lote, por rede de parceiros/marketplace) ou dá
404 limpo. Nunca um id devolveu um lote **diferente** do que ele é em outro tenant.

Isso é consistente com um backend único, com uma tabela de lotes de numeração global (como o vlance), e cada tenant só
**exibindo** (não *possuindo*) um subconjunto — às vezes cruzado com o catálogo de outro leiloeiro parceiro na mesma
rede, o que explica o card da Rodrigo mostrando o lote da Marco Antônio.

**Decisão**: `externalId = String(id)`, **sem prefixo de host** — padrão vlance, ao contrário do soleon/sua-plataforma.
Consequência prática: coletar de vários tenants vai gerar overlap natural (o mesmo lote aparecendo via 2+ tenants) —
a dedução por `UNIQUE(source_id, external_id)` cuida disso sozinha, sem custo extra.

## Mapeamento de campos

| Campo canônico | v1 (Laravel) | v2 (Next.js) |
|---|---|---|
| `externalId` | `lote.id` (não confundir com `bem.id`/"COD.", que é outro id — o `id` da URL é o que importa) | `initialLote.id` |
| `titleRaw` | parágrafo de descrição no card/detalhe (**não** o `<h3>`, que é só a categoria) | `initialLote.titulo` |
| `lotUrl` | `https://${host}/eventos/leilao/{slug}/lote/{id}/{slug}` | `https://${host}/lotes/{id}` |
| `photos` | `<img src>` cujo path contém `/bens/{bemId}/arquivos/` — **excluir** o que tem `/comitentes/` (é o logo do comitente, aparece na mesma lista de `<img>` da página de detalhe) | `initialLote.imagens[].url` |
| `currentBid` | `lote.valorLanceAtual` (ou o "Lance Atual" do card) | `initialLote.lanceAtual` |
| `minBid` | `lote.valorInicial`/`valorInicial2` conforme praça vigente | `initialLote.lanceInicialVigente` |
| `bidIncrement` | `lote.valorIncremento` | `initialLote.incrementoMinimo` |
| `appraisal` | `lote.valorAvaliacao` | `initialLote.valorAvaliado` |
| `auctioneerName` | `lote.leilao.leiloeiro.nome` | `initialLeilao.leiloeiro.nome` (só na página do leilão, não em `initialLote`) |
| `sellerName` | **não encontrado no `var lote` desta amostra** — a única ocorrência de "comitente" no blob v1 é `lanceAtual.dataAprovacaoComitente` (data de aprovação, não o nome); deixar `null` em v1 até achar o campo certo em outro lote | `initialLote.comitente.nome` |
| `docType` | `lote.leilao.judicial` (bool) → `judicial`/`extrajudicial` | `initialLote.modalidade` (`LEILAO_JUDICIAL`) |
| `city`/`state` | **não está no card**; no detalhe, texto livre (não achei um campo estruturado limpo — a `localizacao` estruturada só apareceu no v2) | `initialLote.localizacao.{cidade,uf}` — **medido com valor de baixa qualidade**: um lote trouxe `"cidade":"Conforme consulta no site DETRAN"` (lixo, não uma cidade real) — validar contra lista de UFs/regex antes de gravar |
| `status` | classe CSS `lote-main-status-{N}` no card, ou `lote.status` (int) no detalhe | `initialLote.statusCode`/`statusLabel` |
| `auctionEndUtc` | `lote.leilao.data{praca}` (praça vigente) | `initialLeilao.data{praca}` (mesma estrutura) |
| PII a **nunca** mapear | `lote.lances[]` (tem `ip`, `autor.apelido/cidade/uf`), `lote.arrematante` | — |

## Modelo de encerramento: `pregao_em_horario`

`dataFechamento`/`cronometro` no nível do LOTE vieram **sempre `null`** em toda amostra (v1 e v2, lote aberto e lote já
vendido). Quem carrega a data é o LEILÃO (evento): `data1`/`data2`/`data3` (uma por praça) + `praca` (qual está
vigente agora) — mesmo padrão do `megaleiloes`/`sua-plataforma`. `sourceTz: 'America/Sao_Paulo'`
(`timezone: "America/Fortaleza"` aparece nos campos de data, mas é o mesmo UTC-3, sem horário de verão — usar
`America/Sao_Paulo` por consistência com o resto do projeto).

Achado à parte, não usar para encerramento: o leilão tem `timerPregao`/`timerIntervalo` (60s/60s) — é o cronômetro do
**pregão ao vivo** durante a sessão, mecanismo de tempo real que uma coleta periódica não consegue capturar de forma
útil. Ignorar.

## Status da fonte → canônico

**Amostra pequena — a maior parte não foi observada.** O que apareceu:

| Fonte | Valor visto | Canônico |
|---|---|---|
| v1, classe do card | `lote-main-status-1` / label "Aberto para Lances" | `aberto` |
| v1, `lote.status` (int) | `1` | **ambíguo** — ver armadilha abaixo |
| v2, `statusCode` | `1` / "Aberto para Lances" | `aberto` |
| v2, `statusCode` | `100` / "Vendido" | `vendido` |

Não observei `agendado`, `encerrado` nem `sem_data` em nenhuma das duas arquiteturas — a listagem por padrão só mostra
o que está aberto (não há filtro de status na busca v1; não achei uma listagem de "encerrados" na v2). **Marcar como
não medido** e tratar qualquer `statusCode` v2 fora de `{1, 100}` como desconhecido até medir de novo, guardando o
código bruto em `raw`.

## Armadilhas

1. **`platform='suporte-leiloes'` no banco tem falso positivo real, incluindo um concorrente do próprio projeto.**
   `superbid.net` está marcado com esse platform e `has_lots=true` — se o conector confiar cru na coluna, vai coletar
   (mal) o maior player do mercado usando um parser feito para outra plataforma, **duplicando** o que o
   `src/connectors/superbid.ts` já coleta certo. Validar assinatura antes de tratar como tenant (ver seção Tenants).

2. **v1 × v2 discordam sobre o status do MESMO lote, medido a poucos minutos de diferença.** O lote 10669: a listagem
   v1 (`rodrigoleiloeiro.com.br/buscador?categoria=1`, buscada às 17:57 UTC) mostrava
   `<strong class="strong-status status-1">Aberto para Lances</strong>`. A página de detalhe v2
   (`marcoantonioleiloeiro.com.br/lotes/10669`, buscada minutos antes) trazia `"status":"Vendido","statusCode":100`,
   com histórico de 7 lances incluindo um aceito. É o mesmo registro (mesmo `leilao.codigo`, mesmo título). Ou o
   template v1 cacheia a listagem por um período (mais provável — SSR do v2 não tem esse cache) ou os dois sistemas
   leem réplicas diferentes. **Não confiar na classe CSS do card v1 como status definitivo** quando o lote também é
   alcançável pela rota v2; preferir `statusCode` quando disponível.

3. **HTTP 200 para lote inexistente — só na v2, e com um marcador limpo.** `GET /lotes/999999999` em
   `marcoantonioleiloeiro.com.br` → HTTP 200, título genérico "Marco Antônio Leiloeiro | Lote", e o blob embutido é
   literalmente `"initialLote":null`. Discriminador: `initialLote !== null`, não o HTTP status.

4. **A v1 não devolve 200 limpo pra lote inexistente — devolve 500.** `GET /eventos/leilao/qualquer/lote/999999999/x`
   em `liderleiloes.com.br` → **HTTP 500** "Internal Server Error". Não é um 404 elegante, mas pelo menos discrimina
   (≠ 200). Como o `http.ts` do projeto faz retry automático em `>=500`, uma sonda de validação usando um id inventado
   pagaria 2 retries com backoff à toa — só relevante se o conector algum dia tentar "advinhar" um id; como a coleta
   real sempre parte de ids vistos na listagem, não deve acontecer na prática.

5. **O slug na URL não é validado, só o id — em ambas as arquiteturas** (testado na v1 com slug trocado em id real:
   HTTP 200 normal). Bom pro conector (não precisa montar o slug certo), mas também significa que **não dá pra usar
   "URL resolve" como prova de que o lote existe **e** pertence ao contexto esperado** — só o id importa.

6. **`h3`/título curto do card é a CATEGORIA, não o título do item** — mesmo bug do `soleon.ts`. "Carro" no `<h3>`,
   "MOTOCICLE HONDA / NXR125 BROS KS | 2003/2003 | AZUL" no parágrafo de descrição. Usar o parágrafo, com fallback pro
   `h3` só se o parágrafo vier vazio.

7. **Foto do comitente entra na mesma lista de `<img>` da página de detalhe v1.** No exemplo do lote 29800: 22
   `<img src=".../bens/24609/arquivos/...">` (fotos reais do bem) seguidas de 1
   `<img src=".../comitentes/sl-c-59-....png">` (logo do comitente). Filtrar por `/bens/` no path; excluir `/comitentes/`.

8. **Categoria some do menu quando zerada, mas a rota continua respondendo.** `facanhaleiloes.com.br` e
   `ibecleiloes.com.br` só mostram "Imóveis" no menu (zero veículos ativos agora) — mas `?categoria=1` nesses dois
   tenants devolve HTTP 200 com 0 cards, sem erro. Sempre consultar as duas categorias (1 e 2) direto, nunca decidir
   quais consultar a partir do que aparece no menu.

9. **Dois ids diferentes para "o mesmo item"**: o `id` do lote (usado na URL, `10669`) e o `bem.id` (usado no path das
   fotos e no rótulo "COD." do card, `9412`) são numerações **independentes**. Usar sempre o id do lote como
   `externalId` — é o que a URL pública usa e o que resolve nas duas arquiteturas.

10. **Paginação sem link de última página quando cabe tudo em 1 página** — `.default-pagination .double-right` só
    existe se houver mais de uma página. Ausência do elemento = página única, não erro de parsing.

## PII

A fonte expõe PII em vários níveis, sem exigir login. Citações literais:

- **Placa, chassi e RENAVAM em texto livre na descrição**, nas duas arquiteturas, em lotes de origem judicial:
  `"MOTOCICLE HONDA / NXR125 BROS KS, placa GZY5751, chassi 9C2JD20103R015621, RENAVAM 00812788834, ..."`
  (`marcoantonioleiloeiro.com.br/lotes/10669`, campo `descricao`). `scrubPlates()` cobre isso — aplicar antes de
  gravar título/raw.
- **Nome de parte de processo judicial, em campo ESTRUTURADO (v2), sem precisar de regex**:
  `"exequente":"AGÊNCIA NACIONAL DO PETRÓLEO, GÁS NATURAL E BIOCOMBUSTÍVEIS - ANP","executado":"JOSE LOURENCO LEITE FILHO E OUTRO"`
  e, em outro lote, `"exequente":"WESLEY SANTIAGO DIAS","executado":"MDE – MANUFATURA E DESENVOLVIMENTO DE EQUIPAMENTOS LTDA e outros"`
  — nome de pessoa física em claro. **Nunca mapear `exequente`/`executado` para nenhum campo do lote canônico** (mesmo
  aviso que a spec da sua-plataforma fez pro `Autor`/`Reu` dela — aqui já vem populado, não vazio).
- **IP do licitante, em texto claro, no histórico de lances da v1** (`lote.lances[].ip`):
  `"ip":"2607:5300:201:3100::54a8"`, junto com `"autor":{"id":1745,"apelido":"lancador-site-saraiva","cidade":"Belo Horizonte","uf":"MG"}`
  e `"arrematante":{"apelido":"lancador-site-saraiva","pessoa":{"name":"L*****"}}` (o nome a fonte já mascara; o IP,
  não). Isto é PII de um **licitante**, não do item — mais grave que o `nm_usuario`/`id_usuario` que o vlance exclui,
  porque inclui geolocalização por IP. **Nunca persistir `lote.lances`, `lote.lanceAtual.autor` nem `lote.arrematante`**
  — nem em `raw`. Confirmado condicional: só aparece quando o lote já recebeu lance (lote sem lance tem `lances: []`).
- **Número de processo judicial em claro**, nas duas arquiteturas: `"numeroProcesso":"0004925-74.2015.4.01.3807"`.
  Processo de leilão judicial é público por natureza (é o motivo do leilão existir) — não tratei como PII a mascarar,
  mas registro porque é o tipo de dado que, cruzado com o nome da parte (que É PII), identifica a pessoa com precisão.
- CPF/CNPJ: **não encontrado em claro** na amostra (diferente da sua-plataforma, que tinha "CPF/MF 0X.XXX.XXX-XX"
  visível). Não significa que não exista em outro lote — não é uma amostra grande.

## Volume (extrapolado de 10 tenants v1 — alta variância, tratar como ordem de grandeza)

| Tenant | Veículo ativo | Imóvel ativo | Total |
|---|---|---|---|
| liderleiloes.com.br | 282 | 2 | 284 |
| rodrigoleiloeiro.com.br | 29 | 46 | 75 |
| vecchileiloes.com.br | 5 | 44 | 49 |
| saraivaleiloes.com.br | 58 | 70 | 128 |
| facanhaleiloes.com.br | 0 | 7 | 7 |
| ibecleiloes.com.br | 0 | 2 | 2 |
| ricardogomesleiloes.com.br | 0 | 0 | 0 |
| leiloesja.com.br | 0 | 0 | 0 |
| portellaleiloes.com.br | 0 | 0 | 0 |
| wermelingerleiloes.com.br | 0 | 0 | 0 |
| **Soma (10 tenants)** | **374** | **171** | **545** |

Contagem exata via última página de paginação × 12 + cards da última página (não estimativa de card único — a última
página de cada categoria foi buscada e contada). Média 54,5 lotes ativos/tenant, mas **dominada por um outlier**
(liderleiloes sozinho é 52% da soma) e metade da amostra tem zero.

**Extrapolando** para os ~75 tenants v1 genuínos na mesma proporção (68,6% veículo / 31,4% imóvel, a mesma partição da
amostra): **ordem de grandeza de 4.000 lotes ativos** no total (~2.800 veículo, ~1.300 imóvel). Repito: isto é
extrapolação de uma amostra de 10 sobre 75, com um desvio-padrão que provavelmente é maior que a própria média — não é
uma previsão confiável, é uma ordem de grandeza pra priorizar o trabalho.

v2: `marcoantonioleiloeiro.com.br` tem 205 URLs `/lotes/{id}` não-encerradas no `sitemap.xml` (mistura veículo/imóvel/
diversos, não separei por tipo). `vixleiloes.com.br` não medido (a página de leilão testada não trouxe lotes embutidos).
Como só há 2 tenants v2 confirmados, isso não muda a ordem de grandeza do total.

## robots.txt

- **v1 (Laravel)**: robots.txt **genérico do Cloudflare** ("content signals", sem nenhuma linha `Disallow`), igual em
  `liderleiloes.com.br` e `rodrigoleiloeiro.com.br` — sem `Sitemap` declarado. Sem restrição de path: tudo permitido
  pelo protocolo clássico de robots.txt (as anotações de "content signal" são sobre uso por IA/busca, não sobre
  crawling de path).
- **v2 (Next.js)**: robots.txt customizado, com `Sitemap` declarado. `marcoantonioleiloeiro.com.br`:
  `Disallow: /api/, /conta, /admin/, /_next/, /static/`. `vixleiloes.com.br`: `Disallow: /api/, /login`. Nas duas,
  `/lotes/`, `/leiloes/` e `/buscador` (v1) **estão liberados** — é exatamente o que o conector precisa acessar.

## Cadência

Todas as medições respeitaram 1 req/s por host (gap de 1–1,2s entre chamadas ao mesmo domínio; hosts diferentes sem
espera entre si). User-Agent de navegador real (Chrome 131 / Win64) em todas as chamadas. Nenhum 429/503 observado em
nenhum dos ~30 domínios tocados.
