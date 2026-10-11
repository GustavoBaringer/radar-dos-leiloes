# Recon — preview de link mostra "Entrar · Radar de Leilões"

Veredito: o crawler de preview nunca chega ao handler `/lote/:slug`. O hook global `onRequest`
(`src/legacy-host.ts:329-386`) devolve 302 → `/login?de=...` para qualquer GET sem cookie
`radar_sessao`, porque `/lote/` saiu de `ehPublica` (`src/legacy-host.ts:321`). O bot segue o
redirect e raspa a tela de login, cujo `<title>` é "Entrar · Radar de Leilões"
(`src/web/login-template.ts:2`).

## Evidências
- `src/legacy-host.ts:321-322` — `ehPublica = PUBLICAS.has(caminho) || caminho.startsWith('/assets/')`; `/lote/` não está mais incluído.
- `src/legacy-host.ts:385` — `reply.code(302).header('location', '/login?de=...')`.
- `src/legacy-host.ts:726-855` — handler `/lote/:slug` com SSR + `<title>` do veículo, og:title/og:description/og:image, twitter:card, JSON-LD. Hoje inalcançável para crawler.
- `src/legacy-host.ts:810-818` — comentário prova a contradição: "Anônimo (o robô do WhatsApp...) vê a página do lote"; o handler foi escrito para o bot, mas o hook nunca o deixa chegar. SSR já filtra `raw`/`search_text` (818-820).
- `src/core/antibot/challenge.ts:110-123` — challenge só intercepta POST login/cadastro; não afeta GET /lote.
- `src/legacy-host.ts:885-893` — sitemap assume "/lote exige conta agora" (decisão de produto a respeitar).

## Regressão (git)
- `db61765` (17/09) "Página do lote pública, para o link compartilhado gerar preview" — corrigiu este mesmo bug antes.
- `f7a41e0` (06/10 11:41) "fix: proteger detalhe de lote e tratar ids invalidos" — removeu `caminho.startsWith('/lote/')` de `ehPublica`. **Causa.**
- `de4f678` (02/10) ainda público; `71786d9` (06/10) 401→login no client; `c6c9a0f` (07/10) split carregou a regra fechada.

## Menor correção
No hook `onRequest` (`src/legacy-host.ts`), antes do 302 final (~379-385), liberar como anônimo
(`papel='comum'`, `eu=ANONIMO`) apenas `GET /lote/*` com User-Agent de crawler de preview/SEO
(facebookexternalhit, Twitterbot, LinkedInBot, WhatsApp, Slack-ImgProxy, TelegramBot, Googlebot,
bingbot, Applebot). Humanos sem sessão continuam 302→/login; API continua 401; SSR já filtra campos
sensíveis. Variante mais fechada: responder 200 com `<head>` mínimo só de `<title>`/og:*/canonical
para esses UAs. `scripts/teste-host-contrato.mjs` provavelmente afirma "GET /lote sem cookie → 302"
e precisa de exceção para UAs de preview.
