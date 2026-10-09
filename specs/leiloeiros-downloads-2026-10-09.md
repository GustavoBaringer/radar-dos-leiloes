# Listas em Downloads/leiloeiros

## Inventário
- 13 DOCX: BA, PB, MG, PE, SP, SE, CE, ES, MA, PA, PI, RJ e TO.
- 474 domínios extraídos, incluindo `gmail.com` indevido: 473 sites candidatos.
- 390 previamente mapeados; 83 adicionados como pendentes em `discovered_sites`.
- Não criados registros oficiais em `auctioneers` por inferência.
- Sondagem dirigida: 165 domínios (83 novos e 82 existentes sem conector).

## Coleta confirmada
| Conector | Domínios com lotes persistidos |
|---|---|
| Soleon | construbemleiloes.com.br, gspleiloes.com.br, guariglialeiloes.com.br, leiloesceruli.com.br, maximoleiloes.com.br, snleiloes.com.br, winleiloes.com.br |
| Suporte Leilões | goldenlance.com.br, leiloespb.com.br |
| Sua Plataforma | adrianoapolinario.com.br |

Na conferência final desses 10 domínios: 470 lotes persistidos, 460 com status aberto/agendado/sem_data. Não significa 470 inserções novas: as coletas fazem upsert.

`gracieleiloes.com.br` e `apabrfleiloes.com.br`: contrato confirmado, nenhum lote aceito pelo coletor nesta passada. Permanecem mapeados, sem anunciar cobertura ativa.

## Pendências
- V-Lance: Alvaro já tinha lote; Bom Negócio retornou zero; Sudeste/Terra Brasil retornaram itens descartados. Sem promessa de novos lotes.
- Leilão Investment não apresentou item aprovado na validação desta passada.
- Mozar Miranda: rota individual candidata; não ativado no HTML genérico sem validar contrato do detalhe.
- Sondagem encontrou 26 falhas DNS, 10 inacessíveis, 2 challenges reais e 1 restrição inconclusiva. São bloqueios atuais, não impossibilidade permanente.
- Links de eventos e palavras-chave não foram considerados lotes válidos.

## Reproduzir conferência
`node --env-file=.env --import tsx scripts/validar-leiloeiros-downloads.ts`

Com `--ativar`, atualiza apenas metadados dos 12 domínios com contrato validado. A conferência sem flag é read-only. Coleta dirigida: `SOLEON_DOMAINS`, `SUPORTELEILOES_DOMAINS` e `SUAPLATAFORMA_DOMAINS` (CSV).

Artefatos detalhados da extração e sondagem: `/tmp/opencode/leiloeiros-docx/`. Nenhum túnel ou bypass foi utilizado.
