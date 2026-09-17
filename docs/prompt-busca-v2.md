# Migrar a busca do Radar de Leilões para React/Vite com a identidade da landing

## O que é

`~/projetos/leilao-poc` é o Radar de Leilões: um agregador que indexa **21,7 mil lotes
ativos** (11,7 mil veículos, 10,2 mil imóveis) de 12 plataformas de leilão. A landing em
`/` foi refeita e aprovada. A tela de busca ficou para trás, com outra paleta, outra
tipografia e nenhuma das animações.

A missão é **reconstruir a busca como app React/Vite** com a identidade visual da landing,
sem perder nenhuma função.

## Stack e arquitetura

- Novo app **Vite + React 19 + TypeScript + Tailwind 4**, servido pelo Fastify já existente
- **SSR de verdade**: `renderToString` no servidor para a página do lote (`/lote/:slug`),
  que é a fonte de busca orgânica de cauda longa. Hoje o Fastify injeta `<title>`,
  `<meta description>` e JSON-LD `Product` lidos do Postgres — isso passa a ser render real
- A **landing continua vanilla** (`landing.html/css/js`), intocada
- Os **tokens viram a fonte única**: extrair a paleta, tipografia, raios e sombras da
  landing para um arquivo compartilhado que as duas stacks consomem. A landing e o React
  não podem divergir de cor nem de fonte
- A nova busca **substitui** `/busca`, `/alertas` e `/cobertura` diretamente

## Sistema visual (vem da landing, não invente outro)

```
--canvas:#05070f  --panel:#0b1120  --panel-2:#121b31  --hairline:#1e2941
--brand:#2f6bff   --brand-bright:#5b8cff  --signal:#22d3ee
--verify:#34d399  --bid:#fbbf24
--ink:#eef3ff     --ink-soft:#93a4c4
--r:0.875rem  --r-lg:1rem  --r-xl:1.25rem   --larg:80rem
```

- **DM Sans** (corpo) · **Space Grotesk** (títulos, `letter-spacing:-.02em`) ·
  **JetBrains Mono** (TODO dado numérico, com `font-variant-numeric: tabular-nums`)
- Fundo do corpo com os dois gradientes radiais da landing (azul em 12% -8%, ciano em 92% 4%)
- Container `.faixa`: `max-width:80rem`, `padding-inline` 16 → 24 → 32px por breakpoint.
  **Nunca** usar o atalho `padding`, que zera as laterais
- Header e footer replicando os da landing (logo com o radar animado, nav, ações à direita,
  menu móvel sob `aria-expanded`), adaptados: no app o header carrega a barra de busca e as
  abas, e o "Entrar na lista" dá lugar ao estado da conta
- Revelação por IntersectionObserver como na landing — mas **o conteúdo nasce visível** se o
  JS não confirmar que vai animar. Tudo atrás de `prefers-reduced-motion`

**Densidade é preservada.** A landing é espaçosa; a busca é ferramenta e vive de mostrar
muitos lotes por tela. Herde paleta, fonte, sombra, borda e animação — **não** herde a
escala de respiro. O cartão de lote mantém a largura atual (~250px de trilho).

## Superfícies (todas nesta rodada)

1. **`/busca`** — barra de busca, filtros, barra de resultados, grade, paginação
2. **Gaveta de detalhe do lote** — fotos, lance, prazo, leiloeiro, link para a origem.
   Empilha no histórico: fechar volta, e o botão voltar do navegador fecha
3. **`/alertas`** — CRUD de alertas salvos, canais (sino/e-mail), push via VAPID
4. **`/cobertura`** — tabela de fontes e o que cada uma entrega
5. **`/lote/:slug`** — página pública do lote, com SSR e JSON-LD

`/home` está **fora de escopo**: é tela morta e foi descartada. Não migre, não
reestilize, não referencie. Os endpoints `/api/home` e `/api/home/leiloeiro` só
serviam a ela e não entram no app novo.

## Filtros

Sidebar à esquerda no desktop (250px, sticky). No celular vira **gaveta por baixo**, com
botão "Filtros" mostrando quantos estão ativos.

Oito facetas de **seleção múltipla** — cada uma é um componente com busca interna, não um
`<select>`; o valor sai como `SP,RJ`:

| id | faceta no servidor | observação |
|---|---|---|
| `status` | `statuses` | rótulos fixos |
| `vehicleType` | `vehicleTypes` | rótulos fixos |
| `propertyType` | `propertyTypes` | rótulos fixos |
| `uf` | `states` | |
| `city` | `cities` | **chave sem acento** (`SAO PAULO`); o rótulo vem pronto do servidor |
| `sellerType` | `sellerTypes` | rótulos fixos |
| `sourceId` | `sources` | rótulo por mapa local |
| `auctioneer` | `auctioneers` | |

Mais: `q`, `assetType`, `priceMin`, `priceMax`, `yearMin`, `yearMax`, `sort`,
`onlyWithDate`, `onlyWithPhoto`, `page`.

**Regra que não pode se perder:** cada faceta é contada **ignorando o próprio predicado**.
Sem isso, trocar de "moto" para "caminhão" zera o filtro, porque só sobra a opção já
escolhida. Já foi corrigido uma vez; não regrida.

## Contrato da API (não mexer no servidor além do SSR e das rotas)

```
GET    /api/search?<23 params>     GET    /api/lot/:id        GET    /api/stats
GET    /api/vitrine                GET    /api/sources
GET    /api/brands                 GET    /api/explain
GET    /api/me                     POST   /api/espera
GET    /api/alerts                 POST   /api/alerts         DELETE /api/alerts/:id
GET    /api/alerts/hits            POST   /api/alerts/hits/seen
GET    /api/push/key               POST   /api/push/subscribe
GET    /api/img?u=<url>&w=<px>     WS     /ws
```

## Paridade funcional — o portão de entrega

A troca é direta, sem rota de convivência, então **nada pode cair em silêncio**. Antes de
declarar pronto, cada item abaixo tem de estar exercitado e provado:

- [ ] Busca por texto, com estado de carregando e a barra de progresso
- [ ] As 8 facetas múltiplas, cada uma contada ignorando o próprio predicado
- [ ] Faixas de preço e ano, ordenação, `onlyWithDate`, `onlyWithPhoto`
- [ ] Paginação
- [ ] **URL é o estado**: filtro aplicado aparece na URL; recarregar restaura tudo;
      voltar/avançar do navegador funciona
- [ ] Gaveta do lote abre, empilha no histórico e fecha pelo botão voltar
- [ ] WebSocket: lance novo e coleta atualizam a tela sem recarregar
- [ ] **Toast de encerramento** ("X lotes encerrados") pelo mesmo canal
- [ ] Alertas: criar, listar, apagar, marcar como visto
- [ ] Push: pedir permissão, inscrever, chave VAPID
- [ ] Sessão: `/api/me`, papéis, e o que cada papel vê
- [ ] `/cobertura`
- [ ] `/lote/:slug` com SSR: `curl` sem JS tem de trazer título, descrição e JSON-LD
- [ ] Lista de espera (`/api/espera`)

## Qualidade

- Responsivo de 375px a 1440px, sem scroll horizontal, gutter mínimo de 16px
- Foco visível em tudo que recebe teclado; `aria-*` nos controles e na gaveta
- `prefers-reduced-motion` desliga toda animação
- Console limpo — sem erro nem aviso
- Screenshot em **3 larguras** (375, 768, 1440) de `/busca`, da gaveta e de `/alertas`
  antes de declarar pronto

## Como rodar e validar

```bash
cd ~/projetos/leilao-poc && bash scripts/up.sh     # Postgres 5433, Redis 6380, Keycloak 8081, app 4500
```

A busca exige sessão. Para dirigir logado sem credencial, ver
`scripts/teste-landing.mjs` e `scripts/_teste-comum.mjs`. O Playwright do repo é
`playwright-core` com o chromium em `~/.cache/ms-playwright/chromium-1234/`.

**Screenshot de página inteira não rola a página** — e a revelação por IntersectionObserver
fica presa em `opacity:0`, produzindo PNG vazio. Role a página inteira antes de capturar.

## O que NÃO fazer

- Não tocar em `landing.html`, `landing.css`, `landing.js`
- Não alterar o contrato da API nem o esquema do banco
- Não inventar paleta, fonte ou raio: os tokens da landing são a fonte única
- Não usar dado falso na validação — o banco tem 21,7 mil lotes reais
