# Arquitetura C2 — contexto e contêineres

Visão dos principais processos e dependências externas. O backend Nest/Fastify serve a aplicação web e as rotas; o bundle do navegador não é um serviço implantado à parte. API e worker/CLI usam o mesmo código monolítico, mas podem executar como unidades de runtime separadas.

```mermaid
flowchart LR
  U[Usuário] -->|HTTPS| B[Navegador]
  B -->|HTTP(S) / WS ou WSS conforme ambiente| API[Backend NestJS + Fastify<br/>SSR, frontend e API]
  API -->|OIDC / PKCE| IDP[Keycloak]
  API -->|SQL via Prisma e queries SQL| PG[(PostgreSQL)]
  API -->|filas, locks e eventos| R[(Redis / BullMQ)]
  CLI[CLI e scripts de coleta manual] -->|código compartilhado| C[Conectores]
  W[Worker Node.js / BullMQ] -->|jobs e locks| R
  W -->|usa| C
  C -->|HTTP(S)| S[Sites dos leiloeiros]
  W -->|persistência SQL| PG
  CLI -->|persistência SQL| PG
```

O usuário acessa o bundle servido pelo backend. O backend autentica via Keycloak (OIDC/PKCE). Workers executam jobs BullMQ no Redis, consultam sites por conectores e persistem os lotes no PostgreSQL. Scripts CLI também podem iniciar coletas manuais com o mesmo código.

**Implantação:** o início nativo local usa Nest. A implantação Docker/produção legada ainda está preservada; o cutover permanece pendente, portanto este diagrama não afirma que Nest já seja o host atual de produção. Ver [build do backend](backend-build.md).
