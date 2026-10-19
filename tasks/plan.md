# Plano restante — migração Nest/Prisma

Continuação do plano em docs/migration-tasks.md e dos registros em .slim/deepwork/nest-prisma-migration/. Ordem autorizada pelo usuário: infraestrutura, administração, QA final, operação/cutover. Não iniciar uma etapa antes de fechar a anterior.

## Etapa 1 — infraestrutura

Descoberta, encerramento/verificação, lances ao vivo e freio já têm checkpoints. Resta anti-bot e conferência final do inventário.

Executar serialmente os recortes em todo.md. Preservar APIs, identidade de referências, singleton de recursos, ownership de Redis, quotas, decisões fail-closed, callbacks não fatais e contratos HTTP/WS. Usar shims temporários em core; não adicionar políticas ou dependências. As classes Nest existentes continuam responsáveis por seus casos de uso; não criar wrappers vazios.

Critério de fechamento: implementações canônicas nas camadas corretas, consumidores e testes ajustados, typecheck/build e provas direcionadas aprovados. Revisão de segurança quando necessário; QA agregado permanece etapa 3.

## Etapas seguintes

2. Quatro scripts administrativos e retirada do gateway pg.connect, preservando CAS, locks, backup, dry-run e rollback.
3. QA agregado, benchmark de 15 mil lotes e revisão final.
4. Validação operacional/browser/Docker, runbooks e cutover controlado.

## Riscos

- Duplicar caches/instâncias ao realocar: shims devem reexportar os mesmos objetos canônicos.
- Alterar segurança durante transplante: comparar corpos e executar testes de quotas/degradação/leases.
- Fechar Redis caller-owned ou criar DB em fixtures fake: manter composição e lifecycle existentes.
- Ambiente empresarial: somente loopback; sem túneis ou reinício de processos alheios.
