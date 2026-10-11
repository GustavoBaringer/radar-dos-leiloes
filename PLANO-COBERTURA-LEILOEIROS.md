# Plano de cobertura dos leiloeiros oficiais

## Objetivo e baseline

O cadastro já tem os 1.947 registros da FENAJU. O objetivo é vincular sites e comprovar coleta recorrente, não aumentar o contador artificialmente.

Baseline medido em 10/10/2026; números são fotografias, não garantias de estado futuro:
- 1.947 registros oficiais; 1.195 com domínio e 752 sem domínio.
- 984 domínios únicos associados ao cadastro oficial.
- 884 registros oficiais associados a sites com conector identificado; isso não comprova execução.
- 249 sites mapeados sem vínculo oficial, após dois enriquecimentos comprovados.
- 48.918 lotes armazenados; 15.600 sem identificação de leiloeiro.
- 490 rótulos normalizados distintos no campo de leiloeiro; 268 coincidem textualmente com nomes do cadastro. Rótulos e coincidências não provam identidade.

Fontes: `specs/reconciliacao-oficiais-2026-10-10.md` e consultas/evidências locais em `/tmp/opencode/reconciliacao-oficiais/contagens/` e `contagens-lotes/`.

## 1. Medir execução por domínio

O histórico por conector não demonstra que cada site atendido por ele foi executado.

Registrar ou aproveitar o controle existente para acompanhar, por domínio:
- última tentativa e último sucesso;
- lotes lidos, aceitos e descartados;
- erro ou motivo de ausência de lotes;
- próxima tentativa ou prazo esperado de execução.

Meta: nenhum domínio elegível ficar esquecido na rotação. Sucesso com zero lotes deve ser separado de falha. Reutilizar o scheduler e a persistência existentes antes de adicionar estruturas.

## 2. Garantir a rotação dos conectores existentes

Antes de criar parsers:
1. Confirmar worker e agenda funcionando, sem confundir configuração com execução.
2. Conferir quais domínios entram na seleção de cada conector.
3. Revisar filtros que excluem sites, especialmente `has_lots=false`.
4. Repetir falhas temporárias com espera progressiva, sem martelar sites bloqueados.
5. Alertar ou emitir relatório quando um domínio ultrapassar o prazo esperado sem tentativa.

Proposta inicial, sujeita à capacidade medida: tentar todos os domínios elegíveis ao menos uma vez por semana; sites com lotes ativos recebem frequência maior. Não prometer essa frequência sem testar a capacidade de rotação.

## 3. Fechar o vínculo oficial → domínio

Investigar os 752 oficiais sem site e cruzar os 249 sites sem vínculo com fontes cadastrais e identificação publicada pelos próprios sites.

Priorizar sites que já tenham conector e lotes. Esses vínculos podem ampliar a cobertura comprovada sem desenvolver outro parser.

Nome, matrícula e junta/UF precisam concordar com evidência suficiente. Não inferir pessoas a partir de domínios, substituir conflitos automaticamente, juntar pessoas por nome ou cadastrar novamente quem já existe. Novos registros exigem fonte oficial e identificador estável. Preservar a evidência, idempotência e rollback condicionado.

## 4. Expandir conectores onde houver retorno

Para domínios ainda sem coleta:
1. Identificar plataformas compartilhadas.
2. Ampliar conectores genéricos antes de criar outros.
3. Criar parsers individuais somente para sites estáveis com contrato validado.
4. Manter DNS, WAF e indisponibilidade numa fila separada.

Priorizar quantidade de domínios recuperáveis e lotes úteis, não quantidade de conectores. Conector novo exige coleta real e resultado `lidos/mapeados/gravados/descartados`.

## 5. Identificar melhor os leiloeiros nos lotes

Preencher nome, matrícula e junta quando a fonte fornecer esses dados; só então vincular ao cadastro oficial com identidade suficiente.

O campo atual mistura nomes pessoais, empresas e sites. Separar identificação de pessoa e rótulo de origem sem inventar dados. Corrigir na normalização/conector apropriado e provar que campos ausentes ou conflitantes não produzem vínculos falsos. O inventário atual não reconstrói valores históricos sobrescritos.

## Indicadores de resultado

Apresentar separadamente:
1. Registros oficiais cadastrados: baseline 1.947; não afirmar pessoas únicas sem resolver identidade.
2. Oficiais com domínio preenchido: baseline 1.195; medir separadamente os vínculos comprovados, pois domínio derivado de email não tem a mesma evidência.
3. Domínios com tentativa e sucesso recentes: medir individualmente.
4. Oficiais com lotes identificados e vinculados: reconciliar antes de contar.

Não é possível prometer lotes dos 1.947 registros: alguns compartilham sites, podem estar sem atividade ou publicar apenas itens fora das categorias do Radar. O compromisso verificável é tentativa e diagnóstico para os domínios elegíveis.

## Execução e gates

- Agentes iniciam com contexto limpo; cada etapa tem diagnóstico próprio antes da implementação.
- Fase A: cinco levantamentos independentes, mais teste do baseline e revisão adversarial das premissas.
- Fase B: observabilidade (etapa 1) e correções de rotação (etapa 2), coordenadas pelo compartilhamento de scheduler/worker. Implementação de identificação (etapa 5) pode ocorrer em paralelo somente com arquivos exclusivos.
- Fase C: reconciliação comprovada (etapa 3) e expansão de contratos recuperáveis (etapa 4), em lotes delimitados pelas evidências dos levantamentos.
- Cada fase termina com testes relevantes, revisão independente e correção dos bloqueios antes da seguinte.
- Não declarar etapas completas com configuração, snippets, testes que não exercitam o código real ou coleta manual isolada como única prova de recorrência.
- Preservar alterações de outras sessões, processos existentes e arquivos não relacionados. Sem túneis, exposição pública ou instalação de dependências sem necessidade demonstrada.
- Sem escrita cadastral ambígua: dry-run e aprovação do lote após revisão. Sem deploy/restart automático.
- Antes de cada commit: `npm run typecheck`; commits e publicação somente de entregas validadas, sem forçar branches divergentes.

Prioridade inicial: execução por domínio e rotação dos conectores existentes. Isso revela os esquecidos e melhora a cobertura antes de investir em novos parsers.

## Diagnóstico inicial e limites aprovados

- O ledger por domínio já está definido em `db/016_tenant_collection_attempts.sql`; sua ausência no snapshot anterior não prova o estado atual. Confirmar schema antes de propor ativação, sem executar o migrador geral ou reiniciar o worker.
- Sete conectores usam o scheduler compartilhado. Seletores próprios continuam fora de qualquer conclusão sobre rotação universal.
- A prioridade absoluta de coletas `completed` pode impedir falhas antigas de recuperar sua vez; corrigir e testar seleção multiciclo antes de ampliar populações.
- `has_lots=false` não deve ser removido indiscriminadamente dos filtros: demonstrar falso negativo e contrato recuperável antes de liberar cada fatia.
- Os contadores do observer medem coleta: `returned` não significa lote gravado; `completed` não confirma persistência. Relatórios devem declarar conectores não instrumentados como não observados.
- O upsert pode apagar identificação quando o payload seguinte chega nulo. Preservar nome e matrícula independentemente via `COALESCE` também pode misturar identidades; exigir replay e política de par antes de corrigir.
- Baseline inicial aprovado: typecheck, 47 testes unitários, 5 integrações e reconciliação em tabelas TEMP com rollback. Isso não comprova recorrência operacional.
- Próxima entrega delimitada: preflight atual, relatório read-only reutilizando o ledger e correção de seleção com testes adversariais. Sem novo schema/fila/dashboard, escrita cadastral, backfill ou promessa semanal.
- Pesquisas de identidade e contratos seguem somente leitura. WAF, DNS e fontes sem evidência permanecem pendentes, sem bypass.

## Situação das frentes após a primeira revisão de implementação

| Frente | Estado verificável |
|---|---|
| 1 — Observabilidade | Relatório read-only, migração 016 e SQL real validados independentemente. Na fotografia de 10/10/2026 às 21:01 UTC, o novo ledger tinha zero tentativas e os 984 domínios oficiais estavam sem observação nele. Nenhuma ativação do worker. |
| 2 — Rotação | Correção de starvation validada com ciclos e mutações. Adiamento relativo de falhas recentes preservado; configuração e execução operacional do worker ainda impedem afirmar recorrência. |
| 3 — Vínculos | Seis sites pesquisados. Andra corresponde a registro já vinculado a outro domínio; Bueno requer fonte oficial/ID; Absoluta tem identidade incompleta; Avelar retornou 403; Central Sul/Foco não identificaram pessoa. Nenhuma aplicação adicional. |
| 4 — Contratos | Cinco sites pesquisados. Molgado lote 6 é candidato imobiliário, ainda sem semântica segura de preço/status. Marcus item 3773 contém peças para tear, portanto não é equipamento elegível. Nenhum parser ativado. |
| 5 — Identidade dos lotes | Quinze amostras atuais consultadas. `raw` é projeção insuficiente para replay de identidade/evento; correção genérica e backfill permanecem bloqueados. |

Os três bloqueios da primeira revisão foram resolvidos: fixture HTML Leilotech corrigida com causa demonstrada também no HEAD; executor→API/HTML→observer real exercitado com I/O simulado; adiamento relativo das falhas recentes preservado. Suíte independente: 34/34, typecheck e diff-check verdes. Restaurar a prioridade antiga ou desconectar o observer em cópia isolada fez os mesmos testes falharem, como esperado.

### Entrega de código e reprodução

- Seleção corrigida: `src/connectors/tenant-scheduler.ts`.
- Relatório somente leitura: `node --env-file=.env --import tsx scripts/relatorio-cobertura-dominios.ts`.
- Testes: `node --import tsx --test scripts/teste-tenant-scheduler.ts scripts/teste-relatorio-cobertura-dominios.ts scripts/teste-cobertura-adversarial.ts scripts/teste-executor-tenant-observer.ts scripts/teste-tenant-observer-api.ts scripts/teste-tenant-observer-html.ts scripts/teste-collection-execution.ts`.
- Relatório distingue tentativa, coleta completa e resultado do run. `returned` não é gravado; persistência por domínio permanece desconhecida. Contagens de observação são pares fonte/domínio, não pessoas únicas.
- Sem mudanças em schema, filas, configurações, worker ou cadastros. Sem reinício de processos.

Gate operacional fechado: o usuário autorizou somente `db/016_tenant_collection_attempts.sql`, aplicada em transação sem alterar cadastros, outras migrações, configurações ou processos. Validação independente confirmou 16 colunas, PK, dois índices adicionais, dez checks e duas FKs; a CLI executou o caminho de ledger presente no PostgreSQL real. Dataset vazio comprova compatibilidade da consulta, não agrupamento positivo nem recorrência. Revisão adversarial aceitou esse escopo.

As contagens observadas permaneceram em 1.947 oficiais, 1.195 com domínio e 984 domínios distintos. O relatório mostrou `ledger_available=true`, zero pares fonte/domínio observados e 984 domínios oficiais não observados. Isso não reconstrói tentativas antigas registradas apenas por conector.

A inspeção somente leitura identificou um worker no WSL, mas o processo terminou antes da segunda confirmação. Flags efetivas, versão carregada e ciclos automáticos não foram comprovados; nenhuma instância foi iniciada ou reiniciada por esta entrega. Não concluir que toda execução está desligada, pois outros ambientes não foram comprovados.

Próximo passo, ainda não autorizado: revisar a configuração efetiva do ledger e planejar ativação sem interferir nos processos existentes. Não executar o migrador geral ou prometer recorrência a partir de testes offline ou da simples existência da tabela.

Reverter a migração com `DROP` não é automático: o ledger pode receber dados depois da fotografia vazia. Qualquer reversão destrutiva exige inspeção atual e nova autorização.

## Revisão de 11/10/2026 — os quatro domínios pendentes de PE/SE/PB

Nenhum dos quatro sustenta conector novo. Cada um tem um motivo próprio, medido, e nenhum deles é "falta de parser":

| Domínio | Situação verificável |
|---|---|
| `gracieleiloes.com.br` | Coberto por `suaplataforma`; o que faltava era cadastro. `POST /ApiEngine/GetLotes` devolve 200 com `CountTotal` 1671 e o payload bate campo a campo com `mapLot`. As 9 páginas foram varridas: 1671/1671 itens em status terminal, zero ativos. |
| `coliseumleiloes.com.br` | Contrato existe em `assests/js/functions.js` (`buscarLotes.php`, `detalheLote.php`), mas nenhum HTML público expõe o `idLeilao` exigido. O único leilão da agenda está `EM LOTEAMENTO`. |
| `albuquerqueleiloes.com.br` | NXDOMAIN no autoritativo `com.br.`, para apex e `www`. Sem delegação NS não há host. `albuquerquelins.com.br` foi descartado por decisão do dono: não é a mesma empresa. |
| `leiloesbrasilpe.com.br` | O `http_status=403` gravado não se reproduz: a própria sonda, com o UA do projeto, devolve 200 (3/3). Corrigir o status não basta — a sonda mede `has_lots` na home, que não tem sinal de lote, e o filtro `has_lots IS NOT FALSE` o mantém fora. |

Única escrita aplicada, autorizada e idempotente: inserção de `gracieleiloes.com.br` em `discovered_sites` (`sua-plataforma`, 200, `has_lots` true). Tenants elegíveis de `suaplataforma` passaram de 27 para 28 e a resolução de tenant passa a devolver `www.gracieleiloes.com.br`. Nenhum lote foi coletado: a fonte segue com zero lotes ativos, e a entrada serve para capturar o primeiro lote publicado.

Observação de proveniência: `leiloesbrasilpe.com.br` é um deploy PE cujo `sitemap.xml` aponta para `leiloesbrasilto.com.br` e cujas páginas de erro se titulam "LeiloesBrasilTO". Não confundir com `leiloesbrasil.com.br`, que tem conector próprio.

### Reverificar `coliseumleiloes.com.br` após 30/10/2026

Único dos quatro com chance real de virar conector. O leilão "Veículos e Equipamentos" marcado para 30/10/2026 09:00 estava em loteamento; com os lotes publicados, o `idLeilao` pode passar a ser exposto e o contrato fica observável. Critério de aceite: `idLeilao` encontrado em HTML público e `buscarLotes.php` respondendo JSON de lote. Enquanto isso, o monitor em `htmlagenda.ts` reconhece `EM LOTEAMENTO` e não fabrica lotes.
