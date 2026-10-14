# Investigação de lotes — 2026-10-14

## Execução detalhada: Alfa Leilões e Lance Certo

Acesso serial e público, sem bypass, túnel ou execução concorrente. Comandos de persistência abaixo chamaram `collectTenant` → conector real → `upsertLots`/`startRun`/`finishRun`, com limite e deadline explícitos. Antes de cada gravação, validaram os URLs coletados contra o host permitido; baseline e pós-contagem filtraram `lots.lot_url` via `LOT_SITE_HOST_SQL`. Sem `ensureSources`, notificação, publicação ou coleta global. Não houve mudança de conector: os contratos existentes cobriram os sites e a fixture durável para Alfa foi adicionada; `scripts/teste-vipleiloes.ts` já cobria a seleção/parse single-tenant de Lance Certo.

### Alfa Leilões — https://alfaleiloes.com/

- 12:00:39Z: URL inicial → HTTP 200, final `https://www.alfaleiloes.com/`; HTML da home publicou links positivos `/lote/10795/...`, `/lote/10730/...` e `/leiloes/`.
- 12:01:01–03Z: `/leiloes/` HTTP 200 e lote público `/lote/10795/leilao-de-apartamento-em-santos-sp/` HTTP 200, comprovando catálogo e detalhe público (não apenas home).
- Paginação: `/leiloes/` publicou links `?page=1..5` inicialmente. A enumeração serial posterior, seguindo links HTML observados até esgotar a fila, verificou 148 URLs, sendo raiz e `?page=1` duplicatas canônicas; 147 páginas únicas × 20 cards, exceto a última com 16 = **2.936 cards**. Não há total global confiável declarado pelo site. Uma coleta limitada antes da contagem final confirmou que o limite precisava ser maior: buscas limitadas a 100 e 200 mapearam 100 e 200, ambas parciais.
- Positivo de detalhe: lote 10795, status 200. Exemplo real fora do escopo: cards que não correspondem a imóvel residencial/comercial/fundiário são recusados pela regra de título do parser; a contagem agregada de descarte do conector não separa individualmente as causas.
- Coletas sequenciais (limites 100, 200, 2.956; deadlines 180s, 180s, 600s): run 2729 (12:04:15–12:04:23Z), run 2731 (12:26:28–12:26:44Z), run 2732 (12:31:45–12:34:40Z). A execução final percorreu toda a cadeia de paginação observada e não bateu limite; a nota informa ausência de total global, não página pendente.
- Baseline antes da primeira gravação: 12:04:23Z, **103** linhas / conjunto `external_id` filtrado por host; amostra IDs de linha 327063–327067 (`external_id` 10038, 10742, 10736, 10568, 10739). Pós todos os runs: **2.064** linhas; ganho líquido **1.961**. Final run 2732: 2.936 lidos, 2.063 mapeados, 2.063 upserts, 1.861 IDs novos, 873 descartados, HTTP 200, sem limite atingido. Todos os 2.063 URLs coletados e URLs persistidos tinham host `alfaleiloes.com` depois de normalizar `www` (0 violações). Amostra de IDs novos: 1114568 / external_id 5825; 1114569 / 5849; 1114570 / 5858.
- Acumulado dos três runs, incluindo as duas execuções parciais anteriores: 3.356 lidos, 2.363 mapeados/upserts, 993 descartados; ganhos líquidos calculados do primeiro baseline ao resultado final são 1.961 (as execuções parciais releram lotes que foram reprocessados no run completo).

### Lance Certo — https://www.lancecertoleiloes.com.br/

- 12:04:38Z: URL inicial HTTP 200, final no mesmo host. Links HTML da home conduziram às cinco categorias `/filtro/carros`, `/filtro/motos`, `/filtro/pesados`, `/filtro/outros`, `/filtro/imoveis`.
- 12:04:44–46Z: as cinco páginas HTTP 200. Totais anunciados: carros 0, motos 0, pesados 0, outros 417, imóveis 630 (total 1.047); a paginação nas categorias não vazias publicou links navegáveis. O conector seguiu a paginação observada e os detalhes para todos os candidatos.
- Positivo: card e detalhe público `/leilao/151026CX/lote/947068`, HTTP 200 às 12:05:16Z. HTML do detalhe publicou categoria IMÓVEIS, subcategoria Casa, status Aberto e data `15/10/2026 10h00` (UTC-3); mapeado como lote de imóvel. Exemplo de descarte contratual: os templates `TESTEVIP` não são lotes reais e o conector os exclui; equipamento médico/peças em categoria “outros” também são excluídos pelo classificador/filtro existente.
- Run 2730, coleta 12:05:42Z–12:25:30Z, limite 1.047 derivado da soma dos totais das categorias, deadline 2.400.000 ms. Baseline 12:25:23Z: **951** lotes no host; amostra IDs 1108767–1108771 / external_ids 948082, 948092, 948103, 948111, 948117. Depois: **951**, ganho 0. Lidos 1.047 cards, 946 mapeados/upserts, 0 novos, 101 descartados; HTTP 200; paginação completada sem note de truncagem. Todos os URLs coletados e persistidos eram do host normalizado `lancecertoleiloes.com.br` (0 violações).

| Domínio | Antes | Depois | Ganho | Lidos | Mapeados | Gravados/atualizados | Novos | Descartados | Cobertura/motivo |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| alfaleiloes.com | 103 | 2.064 | +1.961 | 3.356 nos 3 runs (2.936 run completo) | 2.363 nos 3 runs (2.063 completo) | 2.363 | 1.961 | 993 | Run final 2732; 147 páginas únicas/2.936 cards observados; sem total global do site, paginação HTML esgotada; itens não elegíveis; host validado |
| lancecertoleiloes.com.br | 951 | 951 | 0 | 1.047 | 946 | 946 | 0 | 101 | Run 2730; totais anunciados 417+630, cinco categorias percorridas e paginação completa; host validado |

Arquivos/testes: `scripts/teste-alfaleiloes.ts` adiciona fixture durável de card realista, rodada de leilão/data UTC, paginação observada, duplicatas e descarte de item fora do escopo; `scripts/teste-vipleiloes.ts` existente cobre ordem de categorias, páginas/duplicatas, demo, classificação, falha e cancelamento. Comandos de teste e typecheck listados no final.

Comandos de execução: páginas públicas consultadas serialmente com `curl -L --max-time 30` nas URLs explicitadas acima; enumeração Alfa feita por Python `urllib` serial, seguindo apenas links `page=` do HTML, deadline 300 s e validação do host/redirect. Coletas executadas por `node --env-file=.env --import tsx --input-type=module -e '…'` usando `collectTenant`, `withCollectionCancellation`, `startRun`, `upsertLots`, `finishRun` e baseline/query por `LOT_SITE_HOST_SQL`; valores exatos de cada execução: `alfaleiloes.com` source `alfaleiloes`, limits 100/200/2956, deadlines 180000/180000/600000 ms; Lance Certo source `vipleiloes`, tenant `lancecertoleiloes.com.br`, limit 1047, deadline 2400000 ms. Runs e resultados persistidos confirmados por consulta read-only a `collection_runs` para IDs 2729–2732.

## Outros 12 domínios

Páginas iniciais consultadas sequencialmente; catálogo/detalhe, contagens e persistência continuam não executados para estes domínios.

| URL fornecida | Instante UTC | Status / host final | Evidência inicial |
|---|---|---|---|
| https://alfaleiloes.com/ | 11:58:32 | 200 / www.alfaleiloes.com | Home Alfa Leilões; HTML publicou links `/lote/10795/...` e `/lote/10730/...`; não requisitados. |
| https://www.franciscofreitasleiloes.com.br/ | 11:58:34 | 200 / www.franciscofreitasleiloes.com.br | Home identificada como FRANCISCO FREITAS LEILÕES; HTML apontou para área estática de perfil e atendimento; catálogo/detalhe não verificados. |
| https://www.vipleiloes.com.br/ | 11:58:35 | 302, ciclo de redirects (curl excedeu 50); host final permaneceu informado | Parado sem contornar. HTML exibido no terminal era resíduo da resposta anterior, não evidência deste host. |
| https://www.norteleiloes.com.br/ | 11:58:42 | 403 / mesmo host | Bloqueio HTTP; sem tentativa de bypass. |
| https://www.leilo.com.br/ | 11:58:43 | 200 / leilo.com.br | Home Leilo identificada; links de mídia não usados para inferir catálogo. |
| https://www.wirnacampos.com.br/ | 11:58:43 | 000 / não resolvido | DNS `Could not resolve host`; sem retry/bypass. |
| https://www.leiloesmwd.com.br/ | 11:58:43 | 200 / mesmo host | Home identificada como Marcos Wladimir Dulnik; referências PDF em HTML, não verificadas. |
| https://www.lancecertoleiloes.com.br/ | 11:58:44 | 200 / mesmo host | Home acessível; CSS/assets Lance Certo; nenhum catálogo/detalhe requisitado. |
| https://www.joserodovalholeiloes.com.br/ | 11:58:45 | 200 / mesmo host | Home identificada como `leiloesjudiciaismgnorte`; contrato de catálogo não verificado. |
| https://www.victordortaleiloes.com.br/ | 11:58:46 | 410 / mesmo host | Gone; sem coleta. |
| https://www.celsocunhaleiloes.com.br/ | 11:58:46 | 200 / mesmo host | Home identificada; HTML mostrou link público `/agenda-de-leiloes` e `/leilao/14/...`; não requisitados. |
| https://www.lmleiloes.com.br/ | 11:58:47 | 403 / mesmo host | Bloqueio HTTP; sem tentativa de bypass. |
| https://www.lucasleiloeiro.com.br/ | 11:58:47 | 403 / mesmo host | Cloudflare “Just a moment”; sem bypass. |
| https://www.solidusleiloes.com.br/ | 11:58:47 | 403 / mesmo host | Bloqueio HTTP; sem tentativa de bypass. |

## Estado dos demais domínios

“Não executado” não significa zero. Ganho não calculável sem baseline e resultado persistido. VIP Leilões teve ciclo de redirects; o conector `vipleiloes` restringe-se a Érico Sobral e Lance Certo, então nenhuma coleta de vipleiloes.com.br foi tentada.

| Domínio | Antes | Depois | Ganho | Lidos | Mapeados | Gravados/atualizados | Novos | Descartados | Cobertura/motivo |
|---|---|---|---|---|---|---|---|---|---|
| alfaleiloes.com | 103 | 2.064 | +1.961 | 3.356 (3 runs) | 2.363 (3 runs) | 2.363 | 1.961 | 993 | página/detalhe 200; run completo 2732, sem total global |
| franciscofreitasleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Home 200; catálogo/detalhe pendentes |
| vipleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | ciclo 302; conector não autoriza tenant |
| norteleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | 403; sem bypass |
| leilo.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Home 200; catálogo/detalhe não percorridos |
| wirnacampos.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | DNS não resolvido |
| leiloesmwd.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Home 200; catálogo/detalhe não percorridos |
| lancecertoleiloes.com.br | 951 | 951 | 0 | 1.047 | 946 | 946 | 0 | 101 | Run 2730; categorias e paginação completa; host validado |
| joserodovalholeiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Home 200; contrato não verificado |
| victordortaleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTTP 410 |
| celsocunhaleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Home 200; links observados, catálogo/detalhe não requisitados |
| lmleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | 403; sem bypass |
| lucasleiloeiro.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Cloudflare 403; sem bypass |
| solidusleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | 403; sem bypass |

## Verificações e próximo passo

- Testes: `node --import tsx scripts/teste-alfaleiloes.ts` e `node --import tsx scripts/teste-vipleiloes.ts`.
- Typecheck: `npm run typecheck` (resultado reportado no chat após execução).
- Próximo passo verificável: seguir sequencialmente com o subconjunto pendente; reavaliar hosts bloqueados somente sem bypass e coletar quando contrato público/isolamento estiver comprovado.

## Continuação — Leilo, José Rodovalho e Celso Cunha

Execução serial, local e tenant-isolada, sem notificações. O runner `scripts/coleta-tenant.ts` capturou o baseline imediatamente antes de cada persistência por host normalizado em `lots.lot_url`, aplicou guarda de host e verificou o resultado depois do `upsert`.

- **Leilo** — 17:36Z: home, API pública e detalhe público confirmados. A API anunciou 575 candidatos nas categorias Carros 124, Motos 174, Utilitários 32, Pesados 140, Equipamentos 46 e Imóveis 59; durante o run retornou 573. Os 46 descartes foram normalizados como fora de escopo. Run 2734: antes 2.238, depois 2.354, 116 novos; nenhum URL de outro host.
- **José Rodovalho** — 17:32–36Z: home e `POST /core/api/get-lotes` públicos. Retornos observados: 5 veículos e 36 imóveis, todos com `nm_url_leiloeiro=www.joserodovalholeiloes.com.br`; exemplo de detalhe público: lote 221933. Run 2735: antes 68, depois 72, 4 novos; 5 veículos foram descartados pelo classificador existente, sem host divergente.
- **Celso Cunha** — a agenda publicou os eventos 14, 22, 31 e 35. O conector comprovado cobre somente o evento 14; ele mostrou 18 páginas e 343 detalhes públicos (por exemplo, lote 3539). O teto local de 100 foi removido. Run inicial 2736: antes 103, depois 346, 243 novos. A confirmação final 2738, com limite 361 (18 páginas × 20 + 1), releu 343/343, atualizou 343, não inseriu nenhum e terminou sem nota de truncamento. Os demais eventos permanecem fora deste contrato.

| Domínio | Antes | Depois | Ganho | Lidos | Mapeados | Gravados/atualizados | Novos | Descartados | Cobertura/motivo |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| alfaleiloes.com | 103 | 2.064 | +1.961 | 3.356 | 2.363 | 2.363 | 1.961 | 993 | 147 páginas; run 2732 completo |
| lancecertoleiloes.com.br | 951 | 951 | 0 | 1.047 | 946 | 946 | 0 | 101 | categorias anunciadas e paginação completa; run 2730 |
| leilo.com.br | 2.238 | 2.354 | +116 | 573 | 573 | 527 | 116 | 46 | seis categorias da API; run 2734 |
| joserodovalholeiloes.com.br | 68 | 72 | +4 | 41 | 36 | 36 | 4 | 5 | tipos V-Lance 1 e 3; run 2735 |
| celsocunhaleiloes.com.br | 103 | 346 | +243 | 343 no run final | 343 | 343 | 243 no run inicial | 0 | evento 14 completo; outros eventos pendentes |
| franciscofreitasleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | contrato V-Lance respondeu lotes de `nortenordesteleiloes.com.br`; guarda de host bloqueou gravação |
| leiloesmwd.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTML só publicou edital e fotos em PDF; sem catálogo/detalhe estruturado comprovado |
| vipleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | ciclo de redirects; conector não autoriza esse tenant |
| norteleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTTP 403; sem bypass |
| wirnacampos.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | DNS não resolvido |
| victordortaleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTTP 410 |
| lmleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTTP 403; sem bypass |
| lucasleiloeiro.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | Cloudflare 403; sem bypass |
| solidusleiloes.com.br | não medido | não medido | não calculável | não executado | não executado | não executado | não executado | não executado | HTTP 403; sem bypass |

Comandos de persistência executados: `node --env-file=.env --import tsx scripts/coleta-tenant.ts leilo leilo.com.br 575 600000`; `node --env-file=.env --import tsx scripts/coleta-tenant.ts vlance joserodovalholeiloes.com.br 41 600000`; `node --env-file=.env --import tsx scripts/coleta-tenant.ts celsocunha celsocunhaleiloes.com.br 360 600000`, seguido de duas confirmações com limite 361. Testes executados: `node --import tsx scripts/teste-leilo-contrato.ts`, `node --import tsx scripts/teste-vlance-jd.ts`, `node --import tsx scripts/teste-celsocunha.ts` e `npm run typecheck`.
