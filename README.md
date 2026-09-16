# Radar de Leilões — POC

Agregador de **veículos e imóveis** em leilão no Brasil. Busca por palavra-chave com
normalização própria, datas de início e encerramento, lance atual e mínimo, leiloeiro,
comitente e localização, coletados de **nove fontes reais** (~23 mil lotes no índice).

O Radar não é leiloeiro: não intermedeia lance, não recebe pagamento e cada lote leva
para a página original do leiloeiro.

## Subir

```bash
./scripts/up.sh        # containers + migração + API + worker
# interface e API: http://localhost:4500
```

## Coletar sob demanda

```bash
node --env-file=.env node_modules/.bin/tsx scripts/collect.ts            # todas as fontes
node --env-file=.env node_modules/.bin/tsx scripts/collect.ts leilo 400  # uma fonte
curl -X POST localhost:4500/api/collect -H 'content-type: application/json' -d '{"sourceId":"copart","limit":200}'
```

## Peças

| Camada | Onde | O quê |
|---|---|---|
| Banco | Postgres 16, porta 5433 | modelo canônico, histórico de lance, telemetria de coleta |
| Filas | BullMQ sobre Redis, porta 6380 | `collect` a cada 6h por fonte, `refresh` de lote quente a cada 2min |
| Coletores | `src/connectors/` | superbid, copart, leilo, kuss, caixa (API/arquivo) e freitas (HTML com cheerio) |
| Busca | `src/core/normalize.ts` + `repo.ts` | dicionário marca/modelo, filtro estrutural, trigram de apoio |
| API | `src/server.ts` | `/api/search`, `/api/lot/:id`, `/api/stats`, `/api/sources`, `/api/explain`, `/api/collect` |
| Imagens | `/api/img?u=&w=` | proxy com allowlist de host, redimensiona com sharp, cacheia em memória e cai para `nopic.svg` em qualquer falha |
| Tempo real | WebSocket `/ws` | worker publica mudança de lance no Redis, servidor repassa ao navegador |
| Interface | `src/web/` | busca com filtros e facetas, detalhe do lote, tela de cobertura |
| Cartão de lote | `src/web/cartao.js` + `cartao.css` | **um** componente para a busca, a home e a landing — as cópias divergiram uma vez e a home perdeu crédito de foto, selo de desconto e título padronizado |

## Decisões que o levantamento de fontes impôs

- **Três modelos de encerramento.** `timer_por_lote` (Superbid, Leilo), `pregao_em_horario`
  (Copart, Kuss) e `sequencial`. Pregão ao vivo não tem fim por lote, e a interface diz isso
  em vez de mostrar contagem regressiva falsa.
- **Fuso por fonte.** Copart responde em UTC, Superbid em BRT. Tudo é convertido para UTC e
  `source_tz` guarda a origem.
- **Busca no nosso índice.** Nenhuma fonte normaliza: "t-cross" dá zero no Kuss, e
  "mercedes b 200" devolve GLA 200 no Leilo. O dicionário resolve marca e modelo, e o
  filtro vira igualdade estrutural em vez de texto livre.
- **Nada de dado pessoal.** Placa é mascarada, e identificação de licitante (que Kuss e Sato
  expõem) nunca é persistida.
- **Sem credencial vazada.** A chave de Elasticsearch que a Sodré publica no HTML não é usada.

- **Imagem nunca quebra na tela.** Qualquer falha do proxy (host fora da lista, origem
  fora do ar, TLS incompleto) devolve o `nopic.svg` com HTTP 200, porque a tag `<img>`
  não renderiza JSON e o cartão ficaria com um retângulo preto mudo. O cabeçalho
  `x-nopic-motivo` diz por quê.
- **Resolução vem da origem certa.** A Copart publicava `?imageType=thumbnail` (96x72);
  sem o parâmetro a mesma URL entrega 1600x1200. O cartão pede 640px e a galeria 1200px,
  então a página pesa ~850 KB em vez de ~4 MB.
- **TLS por host.** O CDN do Freitas tem cadeia incompleta e falha com
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. A lista fica em `HOSTS_TLS_INCOMPLETO` e vale
  para o coletor e para o proxy.

- **Tipo de bem e tipo de veículo.** `asset_type` (veiculo/imovel/outro) e `vehicle_type`
  (carro, suv, picape, moto, caminhão, ônibus, utilitário, máquina, reboque, náutico)
  saem da taxonomia da própria fonte, com inferência por título só onde a fonte não
  classifica (Kuss e Freitas). Peça vira `outro` e fica fora do resultado padrão.
- **Parser de veículo não roda em imóvel.** Sem essa trava, "IMÓVEL RURAL EM MERCEDES-PR"
  virava Mercedes-Benz e "Sobrado - City América" virava Honda City.

## Armadilhas de API que custaram catálogo

- **Superbid exige `orderBy`.** Sem ordenação explícita a paginação não é estável:
  a mesma página pedida duas vezes devolve conjuntos com 50% de interseção, e paginar
  1..N colhia 5.822 registros com 4.253 únicos. 27% do catálogo nunca entrava.
- **Superbid tem `filter`, muito melhor que `keyword`.** `filter=product.productType.id:N;`
  permite fatiar por categoria. O código antigo exigia `productType.id === 10` e
  descartava caminhão, ônibus, máquina e náutico por construção.
- **Cota por tipo, não global.** Com limite único, os 5.819 carros e motos consumiam
  a cota inteira e as outras categorias nunca eram alcançadas.
- **Leilo não usa acento no campo `tipo`.** Pedir "Caminhões" e "Utilitários" devolvia
  `count: 0` em silêncio. Os valores reais são `Carros`, `Motos`, `Utilitarios`,
  `Sucatas`, `Pesados`, `Equipamentos`, `Imoveis`.

- **Caixa: o antibot responde HTTP 200.** O Radware devolve uma página de CAPTCHA com
  status 200. A detecção é por conteúdo; checar só o código gravaria CAPTCHA no banco.
  O bloqueio é por IP e dura dezenas de minutos, então são 2 requisições por ciclo.
  Para desenvolver com o IP em cooldown, `CAIXA_CSV_PATH` aponta para um arquivo local.
- **A coluna "Preço" da Caixa não é preço.** É o mínimo do 1º leilão, e supera a
  avaliação em 2.424 dos 5.189 lotes de leilão. Vai para `min_bid`, nunca exibida como
  preço, e a avaliação riscada só aparece quando é maior que o lance.

## Rotas e SEO

| Rota | O quê |
|---|---|
| `/` | landing de venda (`landing.html`), com os números vindos de `/api/landing` |
| `/home` | home de navegação do app: carrosséis de últimos lotes e por leiloeiro |
| `/busca`, `/alertas`, `/cobertura` | a casca do app (`index.html`); o cliente decide pela rota |
| `/lote/:slug` | página do lote, com **title, description e JSON-LD renderizados no servidor** |
| `/robots.txt`, `/sitemap.xml` | sitemap gerado do banco, ~22 mil URLs |

A página do lote é a que traz busca orgânica de cauda longa, e ela é casca de SPA:
o robô lê o HTML, não o resultado do `fetch`. Por isso o `<head>` dela é montado no
servidor a partir do lote, enquanto o conteúdo visível continua sendo montado no cliente.

`SEO_PUBLICO=1` tira o catálogo de leitura de trás do portão de senha (landing, busca,
página de lote, cobertura). Sem isso o robô recebe `302` para `/login` e nada é indexado.
As telas de conta e a coleta continuam exigindo sessão. **Vem desligado.**

## Lista de espera

O CTA da landing grava em `espera` (`db/010_espera.sql`). O registro guarda o **texto de
consentimento que a pessoa leu** junto com o e-mail: sem isso não há como demonstrar a
base legal depois, e o dado vira passivo em vez de ativo. Reenvio do mesmo e-mail não é
erro — a resposta diz `jaEstava: true` em vez de devolver 409.

## Classificação: a categoria da fonte nem sempre nomeia o tipo

`Sucata de Carros` do Superbid guarda 125 lotes com moto, picape e D20 dentro — a
categoria nomeia a **condição**, não o tipo do bem, e o filtro de carro devolvia Honda CG.
O título só corrige a categoria quando ela **não discrimina** (`carro`, ou ausente);
categoria específica (`Cavalos Mecânicos`, `Motoniveladoras`) é mais confiável que
qualquer palavra do título. Medido: sobrescrever sempre transformava pulverizador em
picape (*Montana Ranger*) e ônibus em caminhão (*ÔNIBUS SCANIA MODELO COMIL*).

Armadilha relacionada: o dicionário roda sobre texto já normalizado por `fold()`, que
troca `/` e `-` por espaço. Regra com esses caracteres (`semi-?reboque`, `R/`) é **letra
morta** — não dá erro, não dá zero visível, simplesmente nunca casa.

## Status das fontes

Nove conectores no ar: superbid, copart, leilo, kuss, caixa, vlance, soleon, leilaopro
(API ou arquivo) e freitas (HTML com cheerio). O restante do Tier 2 (Palácio, Grupo
Carvalho, Mega, Parque, Suporte Leilões) e o Tier 3 (bloqueados por antibot) seguem no plano.

## Testes

```bash
node scripts/teste-landing.mjs            # landing: leitor, robô e formulário
node --env-file=.env scripts/teste-cartao-home.mjs    # o mesmo cartão na home e na busca
node --env-file=.env scripts/teste-link-leiloeiro.mjs # deep link sobrevive à coleta
node --env-file=.env scripts/teste-auth.mjs           # portão, OIDC, isolamento entre contas, freio
```

## Autenticação

Dois modos, e o código não sabe qual está em uso: `src/core/identidade.ts` expõe
uma `Identidade` com `userId`, e é esse id que alerts, saved_searches e
push_subscriptions usam como dono. É a indireção que torna a escolha de provedor
reversível — trocar Keycloak por Cognito é trocar `OIDC_ISSUER` e `OIDC_CLIENT_ID`,
porque os dois são OIDC, e nada fora de `identidade.ts` e `oidc.ts` encosta nisso.

| Modo | Liga com | Para quê |
|---|---|---|
| Portão de senha | `APP_SENHA` | uso local e a POC atrás do túnel; conta compartilhada |
| OIDC (Keycloak) | `OIDC_ISSUER` | contas de verdade, com reset de senha, verificação e MFA do provedor |

```bash
docker compose up -d leilao-auth     # Keycloak em http://localhost:8081
# realm 'radar' importado de infra/keycloak/realm-radar.json no boot
OIDC_ISSUER=http://localhost:8081/realms/radar npm start
```

O papel sai das **roles do token**, nunca de nada que o cliente mande: quem tem
`radar-admin` no realm vira admin aqui, o resto entra como comum.

O realm é arquivo versionado de propósito. Realm configurado pela tela de admin é
configuração que ninguém sabe recriar depois — e o Keycloak recusa o import inteiro
por um campo desconhecido, então o arquivo também é o que garante que ele sobe.

### Dono

Antes da migração `db/011_usuarios.sql` **nada tinha dono**, porque "usuário" era
uma senha compartilhada: quem entrava via e apagava os alertas de todo mundo, e o
push de um alerta ia para o celular de todos os inscritos. O provedor de identidade
não resolve posse — por isso a coluna `owner_id` veio antes do Keycloak, e não depois.

O dono entra no `WHERE`, não numa checagem separada: entre ler e apagar existe uma
janela, e um 404 honesto é melhor que um 403 que confirma a existência do alerta
de outra pessoa.

### Freio de força bruta

Medido antes de existir: dez senhas erradas seguidas davam dez `401`, sem atraso.
Com uma senha só protegendo o índice e a POC exposta por túnel, era o furo mais
explorável do sistema. O contador vive no Redis, não em memória — contador que
zera no restart não é freio.

Efeito colateral que vale saber: todo teste que entra no sistema precisa zerar o
contador antes (`scripts/_teste-comum.mjs`), senão o teste seguinte toma `429` e
falha com sintoma enganoso ("a home não renderizou cartão", quando nem entrou).

## Acesso protegido por senha

> **Armadilha do `.env`:** o carregador de variáveis do Node trata `#` como início
> de comentário. Uma senha gerada com `#` no meio vira string VAZIA em silêncio, e
> o login falha com "usuário ou senha incorretos" sem nenhuma pista. Ao gerar
> senha, evite `#` — ou aspeie o valor.

`APP_USUARIO` e `APP_SENHA` no `.env` ligam o portão. **Sem `APP_SENHA` o portão
fica desligado** — é o modo local de sempre, sem atrito.

Com o portão ligado, toda rota exige sessão: navegação vai para `/login`, API
responde `401`. Ficam livres apenas o que o navegador precisa ANTES de autenticar
(`/login`, `/api/login`, `/styles.css`) e o `sw.js` — o service worker do push é
buscado sem cookie de sessão, e um redirect ali quebraria a notificação.

Dois cuidados que não são óbvios:

- A verificação de usuário e senha roda **sempre as duas**, mesmo com o usuário
  errado. Sair antes revelaria pelo tempo de resposta qual campo está correto.
- A mensagem de erro é única ("usuário ou senha incorretos"). Dizer qual errou
  confirma para um atacante que o usuário existe.

A sessão é um cookie `HttpOnly` com HMAC e validade de 30 dias. Trocar
`APP_SESSAO_SEGREDO` invalida todas as sessões de uma vez.
