# Tarefas de Implementação: Correção de Máquinas e Implementos Agrícolas na Listagem de Caminhões

## Task 1: Aprimorar regras de identificação de máquinas e implementos agrícolas em `normalize.ts`

**Description:** Atualizar a função `tipoForteDoTitulo` e as tabelas `TITULO_FORTE` e `CAMINHAO_INEQUIVOCO` em `src/core/normalize.ts` para que colheitadeiras com variações de digitação frequentes na fonte (ex: `colheitaderia`), implementos/ferramentas de corte e acoplagem de marcas agrícolas (ex: `New Holland/Plataforma 7220`, `Plataforma 11LX50`, `Plataforma de soja/milho/caracol/draper`), grades agrícolas (`grade aradora`, `grade niveladora`, `grade pesada`) e demais implementos/máquinas agrícolas (`subsolador`, `adubadora`, `plantadora`, `colhedora`, `ceifadeira`, `enfardadeira`) sejam identificados com prioridade e categorizados como `vehicleType: 'maquina'`. A regra protege rigorosamente caminhões cavalo mecânico (`caminhão trator`, `c. trator`, `cam. trator`, `cavalo trator`), guinchos (`caminhão plataforma`, `guincho plataforma`) e caminhões operacionais (`compactador`, `caçamba`, `pipa`), garantindo que permaneçam como `caminhao`.

**Acceptance criteria:**
- [x] Título com erro comum de grafia `COLHEITADERIA - MASSEY FERGUSON/MF 9695 TRIDENT` é classificado como `assetType: 'veiculo'` e `vehicleType: 'maquina'`.
- [x] Plataformas agrícolas associadas a marca agrícola ou especificações de corte (`NEW HOLLAND/PLATAFORMA 7220`, `PLATAFORMA 11LX50`, `Plataforma de corte 20 pes`, `Plataforma Draper`) são classificadas como `vehicleType: 'maquina'`.
- [x] Implementos de solo com grafia padrão (`GRADE ARADORA CRI DE 16C/DSC REC 28`, `GRADE ARADORA PESADA / ANTONIASI`) são classificados como `vehicleType: 'maquina'`.
- [x] Títulos com erro de grafia como `TRATO AGRICOLA MODELO MF 6711` ou tratores no plural (`Tratores agrícolas`) são classificados como `vehicleType: 'maquina'`.
- [x] Títulos legítimos de caminhões rodoviários como `CAMINHÃO TRATOR MERCEDES-BENZ LS 1932`, `C. TRATOR SCANIA P114`, `M.BENZ / LS 1935 / TRA / C. TRATOR`, `CAMINHÃO MERCEDES-BENZ L-2213 COM PLATAFORMA GUINDAUTO`, `Scania G420`, `Constellation` e `Mercedes-Benz Atego Compactador` permanecem inalterados como `vehicleType: 'caminhao'`.

**Verification:**
- [x] Tests pass: `node --import tsx --test scripts/teste-classificacao-filtros.ts` (15/15 passando).
- [x] Build succeeds: `tsc --noEmit` executado limpo sem erros.
- [x] Manual check: `classifyAsset('NEW HOLLAND/PLATAFORMA 7220', 'Pesados')` e `classifyAsset('COLHEITADERIA - MASSEY FERGUSON/MF 9695 TRIDENT', 'Pesados')` retornam `{ assetType: 'veiculo', vehicleType: 'maquina' }`.

**Dependencies:** None

**Files likely touched:**
- `src/core/normalize.ts`

**Estimated scope:** Small (1 file)

---

## Task 2: Adicionar casos de testes unitários e de regressão em `teste-classificacao-filtros.ts`

**Description:** Adicionar uma bateria de testes automatizados dedicados em `scripts/teste-classificacao-filtros.ts` cobrindo todos os títulos reais de máquinas e ferramentas agrícolas extraídos do print do usuário e do banco de dados (colheitadeiras com typo, plataformas New Holland/Massey, grades aradoras, tratores com variação de grafia), além de contra-testes com caminhões tratores rodoviários (cavalos mecânicos com `C. TRATOR`, `CAM. TRATOR`, etc. sob categoria genérica 'Pesados') e caminhões plataforma de socorro para blindar contra falsos positivos e regressões.

**Acceptance criteria:**
- [x] Teste unitário cobre explicitamente `COLHEITADERIA - MASSEY FERGUSON/MF 9695 TRIDENT`, `NEW HOLLAND/PLATAFORMA 7220`, `PLATAFORMA 11LX50`, `GRADE ARADORA CRI DE 16C/DSC REC 28`, `GRADE ARADORA PESADA / ANTONIASI /GRADE PESADA ATA 24GPATA`, `TRATO AGRICOLA, MODELO MF 6711, MARCA MASSEY FERGUSON ANO 20`.
- [x] Contra-testes asseguram que `CAMINHÃO TRATOR MERCEDES-BENZ LS 1932`, `C. TRATOR SCANIA P114` (sob Pesados), `M.BENZ / LS 1935 / TRA / C. TRATOR`, `CAMINHÃO MERCEDES-BENZ L-2213 COM PLATAFORMA GUINDAUTO`, `SUCATA DE CAMINHÃO PLATAFORMA MERCEDES-BENZ L 2013`, `VOLKSWAGEN CONSTELLATION 13 180 COM BAU E PLATAFORMA` permanecem como `vehicleType: 'caminhao'`.
- [x] Todos os testes da suíte passam com 100% de sucesso (15/15).

**Verification:**
- [x] Tests pass: `node --import tsx --test scripts/teste-classificacao-filtros.ts`
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `scripts/teste-classificacao-filtros.ts`

**Estimated scope:** Small (1 file)

---

## Checkpoint: Regras e Testes Automatizados Validados
- [x] Todos os testes em `scripts/teste-classificacao-filtros.ts` executam e passam sem falhas (15/15).
- [x] `npm run typecheck` executa limpo sem erros de tipagem.
- [x] Sem regressão em caminhões legítimos, ônibus, carros e utilitários.

---

## Task 3: Criar script de saneamento retroativo de máquinas e implementos (`scripts/fix-agricultural-categories.ts`)

**Description:** Criar um script dedicado de auditoria e correção retroativa para o banco de dados PostgreSQL (`scripts/fix-agricultural-categories.ts`), seguindo o padrão já consolidado no repositório. O script consulta lotes em `lots` cujo `vehicle_type = 'caminhao'` ou `carro` que possuam evidências inequívocas de máquina agrícola ou implemento de acoplagem (colheitadeiras com ou sem typo, plataformas agrícolas, grades aradoras, pulverizadores, plantadeiras, etc.), exibe o diff no console em modo `--dry-run` e, quando executado com `--aplicar`, realiza a transação SQL atômica atualizando `vehicle_type = 'maquina'`, gerando log de auditoria e recalculando `search_text`.

**Acceptance criteria:**
- [x] Script suporta execução segura em modo `--dry-run` (padrão) exibindo lista detalhada dos lotes candidatos, antes/depois e contagens.
- [x] Script suporta modo `--aplicar` com transação `BEGIN ... COMMIT` e proteção contra inconsistências.
- [x] Recalcula `search_text` e sincroniza o lote para exibição imediata nas consultas de vitrine.
- [x] Não toca em nenhum lote com `CAMINHÃO TRATOR` (cavalo mecânico) ou caminhões com guincho plataforma.

**Verification:**
- [x] Executar script em dry-run: `node --env-file=.env --import tsx scripts/fix-agricultural-categories.ts --dry-run` (auditou 57 lotes candidatos).
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `scripts/fix-agricultural-categories.ts`

**Estimated scope:** Small (1 file)

---

## Task 4: Executar saneamento no banco de dados e validar vitrine de busca

**Description:** Executar a migração retroativa através do script criado no banco de dados PostgreSQL local, validando o número exato de lotes afetados (incluindo os lotes do print: ID 629300 `COLHEITADERIA...`, ID 1115323 e 576785 `NEW HOLLAND/PLATAFORMA 7220`, ID 1115340 e 576852 `PLATAFORMA 11LX50`, ID 629345 e 576801 `GRADE ARADORA...`, ID 629167 `TRATO AGRICOLA...`). Em seguida, inspecionar a busca `/busca?assetType=veiculo&vehicleType=caminhao` para confirmar a total ausência de máquinas agrícolas e a integridade da contagem de caminhões.

**Acceptance criteria:**
- [x] Os lotes 629300, 1115323, 576785, 1115340, 576852, 629345, 576801 e 629167 são migrados com sucesso para `vehicle_type = 'maquina'`.
- [x] Total de 57 lotes no Postgres migrados de `caminhao` / `carro` para `maquina`, preservando 38 caminhões legítimos.
- [x] A consulta de busca `searchLots({ assetType: 'veiculo', vehicleType: 'caminhao' })` retorna 0 máquinas agrícolas.
- [x] Os caminhões reais (Scania, Constellation, Mercedes Atego, Volvo FH, Cargo, etc.) permanecem intactos.

**Verification:**
- [x] Query SQL no PostgreSQL confirmando que nenhum lote agrícola permanece com `vehicle_type = 'caminhao'`.
- [x] Consulta em `searchLots` comprovando 0 contaminações agrícolas na listagem de caminhões.

**Dependencies:** Task 3

**Files likely touched:**
- Execução direta de script e verificação no banco de dados.

**Estimated scope:** Small (0-1 files de execução)

---

## Task 5: Habilitar transição `caminhao -> maquina` no pipeline genérico de backfill

**Description:** Atualizar o script geral de backfill (`scripts/backfill-classificacao-filtros.ts`) para que `evidenceDoTitulo()` e a validação `validateChange` permitam reclassificar lotes com `vehicle_type = 'caminhao'` para `maquina` quando o título contiver evidência forte inequívoca, garantindo que futuras execuções do backfill genérico e de reversão funcionem com segurança.

**Acceptance criteria:**
- [x] Em `scripts/backfill-classificacao-filtros.ts`, `validateChange` aceita transição de `c.before === 'caminhao'` para `c.after === 'maquina'`.
- [x] A condição de reclassificação aceita transição de `'caminhao'` para `'maquina'` quando `strong === 'maquina'`.
- [x] Typecheck do projeto passa sem advertências.

**Verification:**
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** Task 1, Task 4

**Files likely touched:**
- `scripts/backfill-classificacao-filtros.ts`

**Estimated scope:** Small (1 file)

---

## Checkpoint: Base Saneada e Pipeline de Classificação Consistente
- [x] Banco de dados local 100% atualizado, com 0 máquinas agrícolas na categoria de caminhões.
- [x] Scripts de backfill genérico e específico operacionais e testados.

---

## Task 6: Testar ingestão de novos lotes via conector Leilo e proteção do fluxo diário

**Description:** Executar teste prático de coleta direcionada ao conector da Leilo (`leilo`) via script de coleta local (`scripts/collect.ts leilo 30`), simulando o ciclo completo de extração da API da Leilo, passagem pelo `upsertLots`, normalização de tipos e persistência, atestando que novos lotes com categoria `"Pesados"` que sejam máquinas ou plataformas agrícolas sejam gravados diretamente como `vehicleType: 'maquina'`.

**Acceptance criteria:**
- [x] Coleta da Leilo executada com sucesso, reportando métricas claras de `lidos / mapeados / gravados / descartados`.
- [x] Lotes agrícolas ingeridos pela Leilo recebem `vehicle_type = 'maquina'` automaticamente sem reversão para `caminhao` (ex: IDs 1115377, 1115376, 1115374, 1115372 gravados como `maquina`).
- [x] Caminhões ingeridos pela Leilo mantêm `vehicle_type = 'caminhao'`.

**Verification:**
- [x] Log de execução da coleta: `node --env-file=.env --import tsx scripts/collect.ts leilo 30` -> `http=200 lidos=100 mapeados=30 gravados=30 descartados=0`.
- [x] Verificação no banco dos registros atualizados.

**Dependencies:** Task 1, Task 4

**Files likely touched:**
- `src/connectors/leilo.ts` (verificado em execução real de coleta)

**Estimated scope:** Small (0-1 files de teste)

---

## Checkpoint: Conclusão e Entrega Final
- [x] `npm run typecheck` passa sem erros em 100% do projeto.
- [x] Testes automatizados executados e aprovados (15/15).
- [x] Vitrine `/busca?assetType=veiculo&vehicleType=caminhao` limpa de máquinas e implementos agrícolas (0 contaminações encontradas).
- [x] Coleta diária blindada contra reincidência.
