# Tarefas de Implementação: Correção 1 (Challenge Login) e Correção 2 (Classificação Veículos)

## Tarefa 1: Otimizar fluxo de exibição e feedback do Cloudflare Challenge na tela de Login

**Description:** Alterar o comportamento da tela de login para que o container do Turnstile/Cloudflare Challenge não seja renderizado preventivamente de forma visível antes da interação. Ao clicar em "Entrar", o botão deve receber estado visual de loading (`aria-busy="true"`, classe de loading, spinner/texto indicador) enquanto o challenge é executado. Se houver falha (timeout, cancelamento ou erro de rede), o estado de loading é desativado, o botão é reabilitado e a mensagem de erro é exibida no help text acessível (`aria-live="polite"`).

**Acceptance criteria:**
- [x] No carregamento inicial da página e do modal de login, o challenge não exibe caixa cinza/vazia estática.
- [x] O challenge só é disparado visualmente/executado após o usuário submeter o formulário de login ("Entrar").
- [x] O botão "Entrar" exibe estado de loading durante a resolução do challenge e requisição de autenticação.
- [x] Em caso de falha ou cancelamento do challenge, o loading é desligado e o help text exibe a mensagem de erro explicativa.

**Verification:**
- [ ] Build/Typecheck: `npm run typecheck` passa sem erros.
- [ ] Manual check: Abrir `/login` no navegador, verificar que o box escuro não aparece previamente; clicar em entrar com campos preenchidos e validar a transição para loading e a execução do challenge; simular erro/timeout e verificar se o loading é desarmado e o erro exibido no help text.

**Dependencies:** None

**Files likely touched:**
- `src/web/login-template.ts`
- `src/web/challenge.css`
- `src/web/challenge.js` (se necessário ajuste na API de prepare/render)

**Estimated scope:** S (1-2 files)

---

## Tarefa 2: Implementar regras refinadas de classificação para veículos pesados, ônibus e utilitários em `normalize.ts`

**Description:** Atualizar o mecanismo de normalização e classificação de ativos (`classifyAsset`, `tipoForteDoTitulo`, `TITULO_FORTE`, `TITULO_TIPO`, `CAMINHAO_INEQUIVOCO`) para reconhecer com precisão modelos de caminhões da Mercedes-Benz (linhas L, LS, LK, LA, Atron, Accelo, 1113, 1620, 1935, 1938), chassis de ônibus (linhas OF, OH, LO, O-500, encarroçadora Mascarello Gran Mini), utilitários Sprinter (310D, 313, 315, 415 CDI, variações "sprinterm", MB 180D) e filtrar falsos positivos de marca provocados por sufixos como "MB" em modelos da Volkswagen.

**Acceptance criteria:**
- [x] Títulos com `LS 1935`, `LS 1938`, `LS 1634`, `LK 1113`, `LA 1113`, `LK-2217`, `L 1620`, `L 312`, `Acello 815`, `Atron 1719`, `915C`, `710`, `1418`, `1111 MB` são categorizados como `vehicleType: 'caminhao'`.
- [x] Títulos com `OF 1519`, `OF 1318`, `OF 1620`, chassis `OF`/`OH`/`LO` e `Masc Granmini` são categorizados como `vehicleType: 'onibus'`.
- [x] Títulos com `315 CDI`, `313SPRI`, `310D Sprinterm`, `MB 180D` são categorizados como `vehicleType: 'utilitario'`.
- [x] Modelos de terceiros como `POLO MB`, `FOX ROCK RIO MB`, `VOYAGE CITY MB`, `VWGOL 1.6L MB` não são marcados erroneamente como marca MERCEDES-BENZ.
- [x] Carros de passeio reais (Classe A, Classe C, Classe E, GLA, GLK, SLK) permanecem inalterados como `carro` ou `suv`.

**Verification:**
- [ ] Tests pass: criar ou rodar testes automatizados com toda a lista de casos reais dos prints e da base.
- [ ] Typecheck: `npm run typecheck` bem-sucedido.

**Dependencies:** None

**Files likely touched:**
- `src/core/normalize.ts`
- `tests/normalize.test.ts` (ou script de validação de normalização)

**Estimated scope:** S (1-2 files)

---

## Checkpoint: Validação das Regras e Interface
- [ ] `npm run typecheck` sem falhas.
- [ ] Testes unitários de normalização cobrindo todos os títulos dos prints 2 e 3 aprovados.

---

## Tarefa 3: Migração retroativa dos lotes existentes no banco de dados

**Description:** Executar um script seguro de backfill para reclassificar os 53+ lotes afetados no banco de dados Postgres que atualmente estão como `vehicle_type = 'carro'` indevidamente (caminhões, ônibus, utilitários e peças/pneus). O script deve reprocessar o `vehicle_type` e `asset_type` aplicando a lógica oficial corrigida e persistir as alterações.

**Acceptance criteria:**
- [x] Lotes de caminhão Mercedes (ex: IDs 1105464, 419291, 19871, 429697, 429728, 945206, 509264, 1110841, 1110889, 1110951, 1111053, 9690, 9396, 1130117, 264288, 509430, 9288, 116055) passam para `vehicle_type = 'caminhao'`.
- [x] Lotes de ônibus Mercedes (ex: IDs 537522, 537523, 1110717, 1110718, 527264) passam para `vehicle_type = 'onibus'`.
- [x] Lotes de vans/utilitários (ex: IDs 1055952, 258633, 1110920, 1125339, 1127277) passam para `vehicle_type = 'utilitario'`.
- [x] Lote de pneus (ID 1108887) passa para `asset_type = 'outro'`.
- [x] A consulta `/api/vitrine` ou `searchLots` com `q=mercedes&assetType=veiculo&vehicleType=carro` não retorna mais nenhum caminhão ou ônibus.

**Verification:**
- [ ] Consulta SQL pós-migração validando contagem exata e categorias corretas de cada ID.
- [ ] Re-execução da query de busca da vitrine comprovando a ausência de caminhões e ônibus.

**Dependencies:** Tarefa 2

**Files likely touched:**
- `scripts/fix-mercedes-categories.ts` (ou script de migração no repo)

**Estimated scope:** S (1-2 files)

---

## Tarefa 4: Garantir robustez na esteira de coleta (`daily-coverage.ts`, `repo.ts:upsertLots`, conectores)

**Description:** Analisar detalhadamente os fluxos de ingestão do coletor diário `daily-coverage`, dos conectores (`soleon`, `docxhtml`, `htmlagenda`, `vlance`, etc.) e da função central `upsertLots` em `src/core/repo.ts`. Assegurar que nenhum conector envie hardcoded `vehicleType: 'carro'` ou sobrescreva indevidamente o classificador em novas execuções.

**Acceptance criteria:**
- [x] Os conectores que tratam veículos delegam a classificação para `classifyAsset` ou respeitam `tipoForteDoTitulo`.
- [x] A pipeline em `upsertLots` aplica a classificação corrigida em todos os novos lotes e atualizações de lotes existentes.
- [x] Lotes futuros com esses mesmos padrões nunca mais sejam gravados como carro.

**Verification:**
- [ ] Inspeção de código em `src/connectors/soleon.ts`, `src/connectors/docxhtml.ts`, `src/connectors/htmlagenda.ts`, `src/connectors/vlance.ts` e `src/core/repo.ts`.
- [ ] Build/Typecheck: `npm run typecheck`.

**Dependencies:** Tarefa 2

**Files likely touched:**
- `src/core/repo.ts`
- `src/connectors/soleon.ts`
- `src/connectors/docxhtml.ts`
- `src/connectors/htmlagenda.ts`
- `src/connectors/vlance.ts`

**Estimated scope:** M (3-5 files)

---

## Tarefa 5: Teste prático de coleta e cadastro manual dos mesmos lotes

**Description:** Realizar teste prático de execução da coleta para os lotes-alvo através do coletor (ex: `scripts/collect.ts` direcionado aos conectores correspondentes como `soleon`, `htmlagenda`, `docxhtml`), verificando o ciclo completo de leitura, mapeamento, classificação e gravação no banco de dados.

**Acceptance criteria:**
- [x] Teste de coleta manual executado com sucesso reportando métricas de `lidos / mapeados / gravados / descartados`.
- [x] Confirmação de que os lotes recém-coletados mantêm as categorias corretas (`caminhao`, `onibus`, `utilitario`) e não revertem para `carro`.

**Verification:**
- [x] Log de execução do `scripts/teste-coleta-manual-mercedes.ts`.
- [x] Verificação no banco de dados dos registros atualizados pela coleta.

**Dependencies:** Tarefa 3, Tarefa 4

**Files likely touched:**
- `scripts/teste-coleta-manual-mercedes.ts` (execução)

**Estimated scope:** XS (0-1 files de código, focado em execução e validação)

---

---

## Tarefa 6: Aplicar saneamento e classificação para caminhões e pesados da Volvo

**Description:** Estender o classificador para identificar todos os caminhões da Volvo (FH, FM, VM, FMX, NH, NL, N10, N12, EDC, Globetrotter) que estavam sendo categorizados como `carro` (como os casos `Volvo VM 260 6X2R 2008` e `Volvo VM 270 6X2R 2014` reportados pelo usuário), ônibus com chassis Volvo e encarroçadora Irizar, além de blindar peças de freio e cabines de caminhão, mantendo intactos carros e SUVs legítimos (C30, V40, V60, S60, XC40, XC60, XC90, C40, EX30).

**Acceptance criteria:**
- [x] Regras de `CAMINHAO_INEQUIVOCO`, `TITULO_FORTE` e `TITULO_TIPO` atualizadas para cobrir caminhões Volvo nos dois sentidos e com configurações de eixos.
- [x] Regras de ônibus expandidas com encarroçadora `Irizar` e chassis `B58`, `B7R`, `B9R`, `B10M`, etc.
- [x] Detecção de peças em `looksLikePart` e `PART_MARKERS` protegendo lonas/pastilhas/discos de freio e cabines de caminhão contra entrada como veículo.
- [x] Migração retroativa aplicada no Postgres local via `scripts/fix-volvo-categories.ts` (dry-run com 0 regressões em carros/SUVs; 25 lotes saneados).
- [x] Vitrine local `searchLots({ q: 'volvo', assetType: 'veiculo', vehicleType: 'carro' })` limpa, trazendo exclusivamente carros de passeio (V60, S60, C30, V40).
- [x] Teste de coleta manual via `upsertLots` executado com sucesso comprovando classificação imune a categorias genéricas da fonte (`lidos=6 mapeados=6 gravados=6 descartados=0`).
- [x] `npm run typecheck` e suite de testes com 14/14 passando.

---

## Checkpoint: Conclusão e Entrega
- [x] `npm run typecheck` passando sem nenhum erro.
- [x] Interface de login com challenge acionado no clique, loading e help text de erro funcional.
- [x] Classificação de Mercedes-Benz precisa: caminhões e ônibus separados de carros na vitrine e no banco.
- [x] Classificação de Volvo precisa: caminhões (VM, FH, NH, etc.) e ônibus (Irizar, etc.) separados de carros e SUVs.
- [x] Retroativos atualizados e pipeline de coleta diária blindada contra regressão.

