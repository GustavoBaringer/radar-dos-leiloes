# Implementation Plan: Correção de Challenge Cloudflare no Login e Classificação de Veículos Mercedes-Benz

## Overview

Este plano cobre a resolução de dois problemas identificados em produção:
1. **Fluxo de verificação Cloudflare Turnstile no Login**: o widget não deve mais ser carregado/exibido preventivamente antes do clique. Ele deve disparar/aparecer após o usuário clicar em "Entrar", colocando o botão em estado de loading até a conclusão; caso falhe ou expire, o loading é encerrado e o help text exibe a mensagem de erro apropriada.
2. **Correção de classificação de veículos Mercedes-Benz**: lotes de caminhões (séries L, LS, LK, LA, Atron, Accelo, 1113, 1620, 1935, 1938...), ônibus/chassis (séries OF, OH, LO, O-500, encarroçadora Mascarello Gran Mini) e utilitários (Sprinter, MB 180D) estavam caindo na categoria genérica `carro`. O plano detalha o mapeamento dos lotes no banco, correção retroativa, evolução das regras de classificação em `normalize.ts` / pipeline de coleta (`daily-coverage` e conectores) e testes de verificação ponta a ponta.

---

## Architecture Decisions

### 1. Challenge Cloudflare no Login
- **Renderização sob demanda vs Exibição condicional**:
  - Manter o Turnstile com `execution: 'execute'` ou renderização disparada no clique do formulário de login (`submit`).
  - O container `.challenge-slot` começa oculto/vazio para não exibir o retângulo cinza estático antes da ação do usuário.
  - Ao submeter o formulário (após validação nativa de `usuario` e `senha` preenchidos):
    - O botão de submit entra em estado `.loading` (com spinner acessível, `aria-busy="true"`, texto de espera e desabilitado).
    - O `RadarChallenge` inicializa/renderiza o challenge no slot.
    - Se bem-sucedido, obtém o token e prossegue com a requisição `fetch('/api/login')`.
    - Se houver falha, timeout ou erro de rede no challenge, o loading é imediatamente cancelado, o botão é reabilitado e o erro amigável é injetado no `.challenge-status.error` (com `role="alert"` / `aria-live="polite"`).

### 2. Classificação de Veículos (Caminhão, Ônibus, Utilitário)
- **Centralização em `normalize.ts`**:
  - Todos os conectores multi-tenant (`soleon`, `docxhtml`, `htmlagenda`, `vlance`, etc.) e o próprio `repo.ts:upsertLots` utilizam `classifyAsset(...)`.
  - Aprimorar `tipoForteDoTitulo`, `TITULO_FORTE`, `TITULO_TIPO` e `CAMINHAO_INEQUIVOCO`:
    - **Caminhões Mercedes**: Cobrir prefixos `LS`, `LK`, `LA`, `LAK`, `LB`, `L` seguidos de modelos numéricos (ex: `LS 1935`, `LS 1938`, `LS 1634`, `LK 1113`, `LA 1113`, `LK 2217`, `L 312`, `L 1620`), linhas `ATRON`, variações de grafia como `ACELLO`, e modelos pesados clássicos (`710`, `915`, `915C`, `1111`, `1113`, `1214`, `1218`, `1418`, `1620`, `1634`, `1935`, `1938`).
    - **Ônibus Mercedes**: Reconhecer chassis `OF` (`OF-1519`, `OF-1721`, `OF-1722`, `OF-1318`, `OF-1417`, `OF-1620`), `OH`, `LO` (`LO-916`, `LO-915`, `LO-814`), série `O-500` / `O-400` / `O-371`, além de encarroçadoras como `Mascarello` (`Gran Mini`, `Granmini`).
    - **Utilitários Mercedes**: Reconhecer variantes Sprinter com typo (`sprinterm`), modelos de van Sprinter (`310d`, `311`, `313`, `314`, `415`, `416`, `515`, `516` seguidos de `cdi`/`street`), e modelo `MB 180` / `MB 180D`.
    - **Sanitização de Marca / Modelos de Terceiros**: Evitar que carros VW (`Polo MB`, `Fox Rock Rio MB`, `Voyage City MB`, `VWGOL MB`) virem `MERCEDES-BENZ` por conterem o sufixo "MB".
- **Backfill Retroativo Seguro**:
  - Script SQL/TS dedicado para reclassificar os lotes afetados já persistidos no banco de dados sem alterar dados cadastrais legítimos de carros reais.
  - Atualização síncrona de `title_display` e `search_text` quando necessário via rotinas padrão de repositório.

---

## Task List

### Phase 1: Correção do Challenge Cloudflare no Login
- [ ] **Task 1.1**: Ajustar ciclo de vida e estado do Cloudflare Challenge na tela de login ([login-template.ts](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/src/web/login-template.ts))
  - Adicionar suporte a estado de loading no botão "Entrar" (spinner CSS, disable, `aria-busy`).
  - Adiar o carregamento/exibição do widget para o momento do clique de login.
  - Tratar falha/cancelamento: remover estado de loading e exibir mensagem de erro clara no help text.
- [ ] **Task 1.2**: Estilização do loading e help text de erro do Challenge ([login-template.ts](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/src/web/login-template.ts) / [challenge.css](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/src/web/challenge.css))
  - Garantir feedback visual responsivo e alinhado ao design system dark.

### Checkpoint: Verificação da Correção 1
- [ ] Typecheck limpo (`npm run typecheck`).
- [ ] Validação visual e comportamental do fluxo de login e challenge sob demanda.

---

### Phase 2: Regras de Normalização de Veículos Mercedes e Pesados
- [ ] **Task 2.1**: Implementar reconhecimento robusto de caminhões, ônibus e utilitários Mercedes-Benz em `normalize.ts` ([normalize.ts](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/src/core/normalize.ts))
  - Adicionar regexes de caminhões MB (séries L, LS, LK, LA, Atron, Accelo, modelos 710, 915, 1111, 1113, 1620, 1935, 1938).
  - Adicionar regexes de ônibus MB (chassis OF, OH, LO, O-500 e encarroçadora Mascarello Gran Mini).
  - Adicionar regexes de utilitários MB (Sprinter 310/313/315/415 CDI, MB 180D).
  - Prevenir falso positivo de marca MB em carros Volkswagen (Polo MB, Gol MB, Fox MB, Voyage MB).
- [ ] **Task 2.2**: Adicionar testes unitários para os casos críticos identificados ([tests/normalize.test.ts](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/tests/normalize.test.ts))
  - Cobrir todos os títulos observados nos prints 2 e 3 e nas queries do banco.

### Checkpoint: Verificação das Regras
- [ ] Todos os testes unitários de normalização passam.
- [ ] `npm run typecheck` bem-sucedido.

---

### Phase 3: Correção Retroativa no Banco de Dados
- [ ] **Task 3.1**: Script de auditoria e migração retroativa dos lotes existentes ([scripts/fix-mercedes-categories.ts](file:///mnt/c/Users/gustavo.pereira01/radar-dos-leiloes/scripts/fix-mercedes-categories.ts))
  - Identificar todos os lotes com erro de `vehicle_type` ou `asset_type` na base.
  - Atualizar `vehicle_type` para `caminhao`, `onibus`, `utilitario` e `asset_type` conforme a reclassificação.
  - Atualizar lotes não-veículos (como pneus) para `outro`.
  - Re-executar a query de busca `q=mercedes&assetType=veiculo&vehicleType=carro` e certificar que nenhum caminhão ou ônibus permanece.

### Phase 4: Proteção de Pipeline e Teste de Recoleta
- [ ] **Task 4.1**: Validar integração no fluxo de coleta (`daily-coverage.ts`, `upsertLots`, conectores `soleon`, `docxhtml`, `htmlagenda`, `vlance`)
  - Verificar se alguma etapa sobrescreve ou ignora a classificação atualizada.
- [ ] **Task 4.2**: Executar teste de recoleta/cadastro manual com os mesmos lotes através do coletor
  - Simular ou rodar coleta para os lotes-alvo e confirmar que são persistidos/atualizados com as categorias corretas (`lidos/mapeados/gravados/descartados`).

### Checkpoint: Validação Final
- [ ] Busca `q=mercedes&assetType=veiculo&vehicleType=carro` limpa de pesados/ônibus.
- [ ] Tela de login e challenge funcionando com loading e help text.
- [ ] Typecheck e testes 100% íntegros.

---

## Risks and Mitigations

| Risco | Impacto | Mitigação |
|---|---|---|
| Timeout ou indisponibilidade do Turnstile travar o botão de login | Alto | Timeout controlado com fallback automático: desativar loading, reabilitar botão e exibir erro claro no help text com opção de tentar novamente |
| Expressões regulares de caminhão capturarem carros Mercedes legítimos (ex: Classe C, Classe A, SLK, GLA) | Alto | Exigir marcadores específicos de chassis/pesados (`LS \d+`, `LK \d+`, `OF \d+`, `Atron`, `Atego`) e testar extensivamente contra toda a linha de passeio |
| Conectores com categorias cruas incorretas sobrescreverem o tipo | Médio | `tipoForteDoTitulo` tem precedência quando o título declara indubitavelmente o tipo do veículo |
| Falha durante a migração retroativa corromper campos de busca | Médio | Executar migração dentro de transação, validando registros antes e depois com contagem exata |

---

## Open Questions

- Nenhuma pendência impeditiva identificada. O escopo técnico está delimitado e com amostras reais extraídas do banco de dados e dos prints fornecidos.
