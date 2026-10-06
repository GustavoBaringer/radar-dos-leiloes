# Radar de Leilões — guia rápido para agentes

## Contexto fixo
- Branch de trabalho usual: `redesign-busca`.
- Objetivo atual: ampliar cobertura de leiloeiros oficiais sem poluir com arte, colecionáveis, peças/partes e itens fora de imóvel/veículo/máquina/equipamento.
- Landing usa `totalLeiloeiros` = `COUNT(*) FROM auctioneers WHERE domain IS NOT NULL AND domain <> ''`.
- Filtro global anti-colecionáveis fica em `src/core/normalize.ts` / `upsertLots()`.

## Comandos úteis
- Typecheck: `npm run typecheck`.
- Coleta: `node --env-file=.env --import tsx scripts/collect.ts <connector> <limit>`.
- Endpoint local: `http://localhost:4500/api/vitrine`.

## Arquivos-chave
- Conectores: `src/connectors/*.ts`; registro em `src/connectors/index.ts`.
- Descoberta de plataforma: `src/core/descoberta.ts` (`PLATAFORMAS`).
- Persistência/filtros: `src/core/repo.ts`, `src/core/normalize.ts`.
- Landing: `src/web/landing.*`, métricas em `src/server.ts`.

## Funil atual de cobertura
- Oficiais com domínio: 1.193 leiloeiros / 983 domínios.
- Restantes sem plataforma após `htmlagenda`: 495 domínios.
- Prioridade: DNS recuperável → sites 200 sem contrato → HTML com links/parser individual → WAF/403 só documentar ou Playwright/proxy depois.

## Regras de entrega
- Antes de commitar: `npm run typecheck`.
- Não commitar arquivo não relacionado sem pedido explícito.
- Preferir conectores genéricos multi-tenant; individuais só quando contrato/HTML for único e estável.
- Ao testar conector novo: rodar coleta real e reportar `lidos/mapeados/gravados/descartados`.
