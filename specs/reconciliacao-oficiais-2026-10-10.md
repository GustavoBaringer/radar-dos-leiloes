# Reconciliação oficial — escopo bounded (2026-10-10)

## Escopo e estado

Esta entrega cobre **somente dois enriquecimentos de domínio** entre os 1.947 registros `auctioneers` do snapshot de 2026-10-10T13:15:31.525Z. Não representa a conclusão da reconciliação documental. O snapshot tinha 1.193 registros com domínio; após aplicação persistida são 1.195. Total de registros permaneceu 1.947.

Snapshot e evidências operacionais fora do repositório:
- `/tmp/opencode/reconciliacao-oficiais/banco/snapshot.json`
- `/tmp/opencode/reconciliacao-oficiais/banco/matches-evidencias.json`
- `/tmp/opencode/reconciliacao-oficiais/banco/backup-antes-apply.json` (pré-escrita, apenas campos necessários; sem contatos)
- `/tmp/opencode/reconciliacao-oficiais/banco/apply-evidencia.json`
- `/tmp/opencode/reconciliacao-oficiais/banco/rollback-condicionado.sql`

## Aplicação restrita

Compare-and-set por `id`, `registry`, `external_id`, `name`, `matricula`, `junta`, `uf`, `uf_junta`, domínio/origem do snapshot; exigiu `blocked=false` e situação regular. Somente `domain` e `domain_origin` mudaram em `auctioneers`; `collected_at` foi preservado. Nenhum INSERT/merge ou troca de domínio preexistente.

| id | Identidade comprovada | Domínio aplicado | Origem |
|---:|---|---|---|
| 130 | fenaju/792; Fernando Caetano Moreira; JUCESP 1156 | gspleiloes.com.br | reconciliado_site_fenaju |
| 1271 | fenaju/1303; Sergio Roberto Nogueira Lima; JUCEPI 020/21 | snleiloes.com.br | reconciliado_site_fenaju |

Fontes informadas pelo librarian em 2026-10-10: [GSP — quem somos](https://www.gspleiloes.com.br/quem-somos) e [SN — quem somos](https://snleiloes.com.br/quem-somos). A correspondência exigiu nome normalizado e matrícula+junta exatos. A matrícula `020/21` versus `20/2021` é apenas divergência para revisão, não normalizada como match.

Os dois `discovered_sites` existentes receberam somente os valores `auctioneers=1` e `ufs` (SP/PI). Permaneceram intactos: status HTTP 200, `has_lots=true`, plataforma/conector `soleon`, `checked_at`, nota e demais metadados. Os valores anteriores e posteriores constam na evidência.

Estado pós-aplicação (SELECT): total `auctioneers=1947`; com domínio pela regra real da landing `domain IS NOT NULL AND domain <> ''` = 1195. Linhas 130 e 1271 confirmadas com `blocked=false` e `situacao=Regular`. Segunda execução `--apply` classificou ambas como `already-applied`, com zero updates.

## Verificação e rollback

- Teste: `node --env-file=.env --import tsx scripts/teste-reconciliacao-fenaju.ts` — passou usando o SQL de upsert de produção numa tabela TEMP manual; cobriu insert, update normal, preservação contra `null/email/declarado/dominio_url`, recuperação de origem reconciliada vazia, domínio efetivamente retornado no mapa e zero `RETURNING` quando nome, matrícula, junta ou UF diferem. O caminho de produção lança erro explícito ao receber zero linhas, antes de atualizar o mapa; o teste cobre esse helper e o wiring local, não a sincronização completa da descoberta.
- Mutation check substituiu em memória os `CASE` de preservação por `EXCLUDED`; a asserção detectou a regressão sem editar o código de produção.
- Rollback usa um bloco `DO` atômico com `GET DIAGNOSTICS ROW_COUNT` após cada uma das quatro operações; qualquer contagem diferente de 1 lança exceção. O SQL guarda identidade e domínio/origem atuais, valores exatos do backup (incluindo NULL vs string vazia) e metadados originais de `discovered_sites`. Teste TEMP cobriu sucesso e divergência concorrente no segundo alvo: falha e nenhuma das quatro linhas é revertida. O bloco/helper é exercitado em tabela TEMP; não executa a sincronização completa da descoberta.
- `npm run typecheck` — passou.
- Sem rede, túneis, coleta ou importador.

## Pendências e limites

- Guariglia (JUCESP 415): `guariglia.leilao.br` / origem `dominio_url` mantido; não substituído por `guariglialeiloes.com.br`.
- Paulo Eduardo (JUCESP 868): `loopbrasil.com` / origem `email` mantido; não substituído por `winleiloes.com.br`.
- Cleber da Silva Melo: homepage sem junta declarada; não inferir junta a partir de PB.
- Francisca Graças de Oliveira Medeiros / Construbem: snippet não validado, apenas candidato.
- Sérgio / JUCEMA 31/2021: não existe registro correspondente no snapshot; confirmar por fonte oficial antes de cadastrar. Não unir ao registro JUCEPI.
- 118 divergências de UF continuam sem correção; 7 conflitos de hyperlinks permanecem em quarentena/revisão.

## Contexto da triagem DOCX (sem matching pessoal)

Fila baseada em URLs/hosts, não em identidade. 473 sites DOCX válidos: 371 com vínculo conhecido e 102 sem vínculo. Na triagem **pré-aplicação** foram classificados 1.233 `discovered_sites`: 130 vinculados a múltiplos registros, 852 a um e 251 sem vínculo. Esses 251 eram discovered_sites retroativos sem vínculo (não 251 hosts DOCX); entre eles: 65 com lotes+conector, 26 só conector e 160 demais. Após os dois vínculos desta entrega, restam 249 sem vínculo. A fila integral preservada abaixo é o recorte histórico pré-aplicação, apenas hosts e prioridade, sem contatos ou nomes; origem: `/tmp/opencode/reconciliacao-oficiais/triagem/fila.json`.

```json
{
  "generated_from": "fila.json",
  "snapshot_stage": "pre-application",
  "unlinked_discovered_sites_after_bounded_apply": 249,
  "linked_by_this_scope": [
    "gspleiloes.com.br",
    "snleiloes.com.br"
  ],
  "unlinked_discovered_sites_by_priority": {
    "connector_and_lots": [
      "absolutaleiloes.com.br",
      "adrianoapolinario.com.br",
      "agencialeilao.com.br",
      "alegranzzileiloes.com.br",
      "alienajud.com.br",
      "andraleiloes.com.br",
      "apiceleiloes.com.br",
      "auctio.com.br",
      "avelarleiloes.com.br",
      "bastonleiloes.leilao.br",
      "brenohenriqueleiloes.com.br",
      "buenoleiloes.com.br",
      "canaldeleiloes.net",
      "centralsuldeleiloes.com.br",
      "clicleilao.com.br",
      "confiancaleiloes.com.br",
      "construbemleiloes.com.br",
      "custodioleiloes.leilao.br",
      "danielchaiebleiloeiro.com.br",
      "djleilao.com.br",
      "doleiloes.com.br",
      "doleiloes.leilao.br",
      "e-confianca.com.br",
      "e-leiloeiro.com.br",
      "elisaleiloes.com.br",
      "ferronatoleiloes.com.br",
      "focoleiloes.com.br",
      "goldenlance.com.br",
      "gspleiloes.com.br",
      "guariglialeiloes.com.br",
      "hastasleiloes.com.br",
      "hd.leilao.br",
      "idleiloes.com.br",
      "jhcleiloeirooficial.lel.br",
      "joserodovalholeiloes.com.br",
      "jrleiloes.com.br",
      "leilaonet.com.br",
      "leilaooficialonline.com.br",
      "leilaotecnico.com.br",
      "leiloariasmart.com.br",
      "leiloesceruli.com.br",
      "leiloesgold.com.br",
      "leiloespb.com.br",
      "leiloeszanoni.com.br",
      "luminaleiloes.com.br",
      "magalhaesleiloes.com.br",
      "maximoleiloes.com.br",
      "mercadoleiloes.leilao.br",
      "michelesandorleiloes.com.br",
      "munizleiloes.com.br",
      "pbcastro.com.br",
      "peterlongo.leilao.br",
      "portalzuk.com.br",
      "ramosleiloes.leilao.br",
      "reisleiloes.com.br",
      "ribeiroleiloes.com.br",
      "rosentalleiloes.com.br",
      "snleiloes.com.br",
      "teza.com.br",
      "thaisteixeiraleiloes.com.br",
      "tmleiloes.com.br",
      "trustbid.com.br",
      "vegasleiloes.com.br",
      "webleiloes.com.br",
      "winleiloes.com.br"
    ],
    "connector_only": [
      "aleiloeira.leilao.br",
      "apabrfleiloes.com.br",
      "arremax.com.br",
      "bigleilao.com.br",
      "bomnegocioleiloes.com.br",
      "clic.leilao.br",
      "danielgarcialeiloes.leilao.br",
      "donizetteleiloes.com.br",
      "duarteleiloes.com.br",
      "felfilileiloes.com.br",
      "gracieleiloes.com.br",
      "jmleiloes.com.br",
      "judhastas.com.br",
      "judicial.satoleiloes.com.br",
      "lancecertoleiloes.leilao.br",
      "lbleiloes.com.br",
      "magalhaes.leilao.br",
      "megaleiloesms.com.br",
      "oroleiloes.com.br",
      "osvaldoleiloes.com.br",
      "polileiloes.com.br",
      "rochaleiloes.leilao.br",
      "shopleiloes.leilao.br",
      "sold.superbid.net",
      "sudesteleiloes.com.br",
      "terrabrasilleiloes.com.br"
    ],
    "neither": [
      "adaianagarcialeiloes.com.br",
      "albuquerqueleiloes.com.br",
      "alexandridis.leilao.br",
      "alvaroleiloes.com.br",
      "amaralleiloes.leilao.br",
      "amarquesleiloes.com.br",
      "amleiloeiro.leilao.br",
      "andrealeiloeirapublica.lel.br",
      "aquino.leilao.br",
      "aragaoleiloes.leilao.br",
      "arthurnunes.leilao.br",
      "atomazellileiloeira.com.br",
      "ayrtonporto.leilao.br",
      "battaglialeiloeiro.com.br",
      "bezerraleoloes.com.br",
      "bgnleiloes.com.br",
      "bhsleiloes.leilao.br",
      "bidgo.leilao.br",
      "bourgerthteixeiraleiloeiros.com.br",
      "bramoleiloes.com.br",
      "brfleiloes.com.br",
      "britoleiloes.com.br",
      "busca.leilao.br",
      "c3leiloes.com.br",
      "carrollruralleiloes.com.br",
      "clebercardoso.leilao.br",
      "clicleiloes.com",
      "coimbraleiloes.com.br",
      "comprei.leilao.br",
      "corleiloes.com.br",
      "correaquinhonesleiloes.com.br",
      "csleiloes.com.br",
      "ctmleiloes.com.br",
      "dantasleiloes.com.br",
      "dcmleiloes.com.br",
      "diego.leilao.br",
      "emiliomatosleiloes.com.br",
      "ericosobral.com.br",
      "fabiobarbosaleiloes.leilao.br",
      "fabrikadeleiloes.com.br",
      "faroonline.com.br",
      "fernandalimaleiloes.com.br",
      "fernandoleiloeiro.com.br",
      "ferreiraleiloes.leilao.br",
      "focoleileos.com.br",
      "foxleiloes.com.br",
      "fvleiloes.com.br",
      "gabrieltorresleiloes.com.br",
      "gbleiloes.leilao.br",
      "gelson.leilao.br",
      "gestordeleiloes.leilao.br",
      "giovanabolico.leilao.br",
      "gomes.leilao.br",
      "gustavoleileiro.com",
      "gustavoreisleiloes.leilao.br",
      "hallalleiloes.com.br",
      "hastalegal.com.br",
      "hitoleiloes.com.br",
      "insigneleiloes.com.br",
      "isoldaleiloes.lel.br",
      "jeleiloes.leilao.br",
      "jocaleiloesagro.com",
      "jocaleiloesagro.com.br",
      "jonasleiloeiro.com.br",
      "jrfleiloes.com.br",
      "kronleiloes.com.br",
      "kwara.leilao.br",
      "leialeiloes.com.br",
      "leilaoinvestment.com.br",
      "leilaoonline.com.br",
      "leilaoonline.net",
      "leilaovip.com.br",
      "leiloeirodian.com",
      "leiloeiroeduardo.com.br",
      "leiloeirojudicial.lel.br",
      "leiloeirorodolfomacarini.com.br",
      "leiloescostaesilva.com.br",
      "leiloesitamar.com.br",
      "leiloesmwd.com.br",
      "leiloessantosmoraes.com.br",
      "leiloestaniaabreu.wix.com.br",
      "lilianportugal.leilao.br",
      "livialeiloes.com.br",
      "lucasleiloeiro.com.br",
      "luizacardosoleiloeira.com.br",
      "lutheroleiloes.leilao.br",
      "mafraleiloes.com.br",
      "marcia.nunes",
      "marcotulioleiloes.com.br",
      "maxxleiloes.com.br",
      "mikedutraleiloeiro.com.br",
      "milanleiloes.com.br",
      "mirandacarvalholeiloes.com.br",
      "mjleiloes.leilao.br",
      "mlleiloes.leilao.br",
      "monago.com.br",
      "mozarmirandaleiloes.com.br",
      "mvleiloes.lel.br",
      "nacionalleiloes.com.br",
      "nakakogueleiloes.com.br",
      "nakakogueleiloes.leilao.br",
      "nevesleiloes.com.br",
      "nordesteleiloes.com",
      "pagliarinileiloes.com.br",
      "palaciodosleiloes.leilao.br",
      "pereiraleiloes.com.br",
      "pestana.leilao.br",
      "pestileleiloes.com.br",
      "pmklog.com.br",
      "polileiloes.leilao.br",
      "positivoleiloes.com.br",
      "presottoleiloes.leilao.br",
      "primeirapraca.com.br",
      "projuleiloes.com.br",
      "psjleiloes.com.br",
      "psnleiloes.leilao.br",
      "qleilao.leilao.br",
      "raulbarbosa.lel.br",
      "rdleiloes.leilao.br",
      "reginaaudeleiloes.leilao.br",
      "ricardocorrealeiloes.com.br",
      "ricartleiloes.com.br",
      "rpleiloes.leilao.br",
      "ruamgotardoleiloes.com.br",
      "rubenshcastro.com.br",
      "saleiloes.leilao.br",
      "sancarleiloes.com.br",
      "sanchesleiloes.leilao.br",
      "santosmoraesleiloes.leilao.br",
      "schererleiloes.com.br",
      "serranaleiloes.com.br",
      "serranaleiloes.leilao.br",
      "serrano.leilao.br",
      "sfrazao.leilao.br",
      "shiokawaleiloes.com.br",
      "silvaleiloes.com.br",
      "solidusleiloes.com.br",
      "sousa.leilao.br",
      "suedpeterleiloes.leilao.br",
      "tabaleiloes.com.br",
      "tamiriscarvalholeiloeira.com.br",
      "thomazdeaquino.leilao.br",
      "tonoleilao.com.br",
      "tribunaleiloes.leilao.br",
      "trombettaleiloes.com.br",
      "tulioleiloes.leilao.br",
      "usadao.leilao.br",
      "vardanaleiloes.leilao.br",
      "vargasepinto.leilao.br",
      "vbleiloes.com.br",
      "vmleiloes.leilao.br",
      "vvleiloes.com.br",
      "willianmachadoleiloeiro.com.br",
      "wirnacampos.com.br",
      "wspleiloes.leilao.br",
      "wwwbezerraleiloes.com.br",
      "zago.leilao.br",
      "zak.leilao.br",
      "zalli.leilao.br",
      "zanileiloes.leilao.br"
    ]
  }
}
```
