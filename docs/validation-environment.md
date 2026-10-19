# Ambiente isolado de validação da migração

`node scripts/test-environment.mjs up` inicia ou valida somente o container fixture `radar-nest-migration-auth`, com a imagem Keycloak 26.0 existente. Publica apenas em `127.0.0.1:58081`, importa o realm em modo somente leitura e verifica assinatura JWT e papéis dos dois usuários. `check` verifica OIDC sem iniciar containers. Não gerencia PostgreSQL/Redis nem outros containers. A fixture permanece disponível para os testes seguintes; a limpeza deve atingir somente o container criado para esta migração.

As credenciais desta fixture são valores públicos e descartáveis de teste. Não utilize esses usuários, senhas ou segredos em outros ambientes.

Para iniciar o backend separadamente, estes valores apontam somente às dependências isoladas:

```dotenv
NODE_ENV=test
BIND_HOST=127.0.0.1
PORT=45450
SITE_URL=http://127.0.0.1:45450
DATABASE_URL=postgresql://radar_test:radar_test_local@127.0.0.1:55433/radar_prisma
REDIS_URL=redis://127.0.0.1:56380
OIDC_ISSUER=http://127.0.0.1:58081/realms/radar-migration-test
OIDC_CLIENT_ID=radar-test-web
OIDC_CLIENT_SECRET=radar-test-client-secret
OIDC_ROLE_ADMIN=radar-admin
APP_SESSAO_SEGREDO=radar-migration-fixture-cookie-secret-not-for-production
```

Nenhum `.env` foi criado ou alterado, nem defaults de produção substituídos. Não exponha esses serviços à internet nem configure túneis.
