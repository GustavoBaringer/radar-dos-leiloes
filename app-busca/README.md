# Template build-frontend

Vite + React 19 + TypeScript + Tailwind CSS 4, com sistema de tokens em `src/styles.css`
(contrato shadcn/ui + paleta de marca nomeada por função) e primitivos em `src/components/ui/`.

```bash
npm install
npm run dev          # http://localhost:13000 (PORT=xxxx para trocar)
npm run verify       # typecheck + build
npm run screenshot   # node scripts/screenshot.mjs [url] [pasta]
```

Gerado pela skill `build-frontend`. A identidade visual de cada projeto entra no bloco
MARCA de `src/styles.css` — a paleta que vem no template é placeholder.
