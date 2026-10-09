# Alertas agrupados por coleta

## Problema e objetivo

Uma busca salva pode encontrar vários lotes novos em uma mesma coleta. Receber um push por lote gera excesso de interrupções. O usuário deve receber um resumo por alerta, com a quantidade de novidades e acesso aos resultados.

## História de usuário

Como usuário com uma busca salva, quero receber um único aviso quando uma coleta encontrar vários lotes para meu alerta, para avaliar as oportunidades sem receber uma sequência de notificações.

## Regras de produto

- Unidade de agrupamento: dono + ID do alerta + execução de coleta. Nomes iguais não misturam alertas.
- Dez lotes novos para o alerta X produzem um push por aparelho inscrito e um e-mail para o endereço configurado, respeitando os canais habilitados.
- Push: título `Radar`, corpo `Encontramos 10 novos lotes para o seu alerta "X"`. E-mail e aviso dentro da aplicação usam o prefixo `Radar:` com a mesma mensagem.
- Um lote usa `Encontramos 1 novo lote`; zero lotes não produz mensagem.
- O push abre `/alertas?alertId=X`, com os lotes daquele alerta. A página permite voltar a todos os resultados. O e-mail mantém a lista de lotes com links e valores.
- A criação do alerta continua mostrando a quantidade já existente apenas como informação. Não envia resumo retroativo: só entram lotes com `first_seen_at >= created_at` do alerta, abertos e não vencidos.
- O mesmo lote não dispara novamente para o mesmo alerta. Os resultados continuam individuais na tela; o contador do sino representa lotes não vistos, não resumos enviados.
- Ao abrir um alerta pelo push, apenas os hits desse alerta são marcados como vistos. A leitura geral mantém o comportamento anterior de marcar todos.
- Coletas diferentes geram resumos diferentes, inclusive para um mesmo alerta. Esta versão não acumula várias fontes em uma janela temporal.

## Decisões técnicas

O ponto de entrada continua `processarAposColeta`, compartilhado pela coleta manual e pelo worker. O casamento mantém o retorno de hits individuais para preservar os contratos existentes. `agruparDisparos` agrupa e deduplica lotes por dono e alerta na entrega. Os avisos via WebSocket são agrupados no cliente, após o filtro de dono existente no servidor.

O casamento passa a processar todos os lotes recebidos, removendo o limite arbitrário de 50. A inserção dos hits usa `unnest` e uma operação em lote com `ON CONFLICT (alert_id, lot_id) DO NOTHING RETURNING lot_id`; só os hits realmente inseridos participam do resumo. O UNIQUE existente também protege contra avaliação concorrente. Nenhuma migração de banco é necessária.

Cada lote do grupo é marcado no canal depois da entrega. Push exige sucesso em pelo menos um aparelho; falha em todos não marca o grupo. Inscrições 404/410 são removidas, demais falhas incrementam o contador existente. SMTP ausente ou falha de envio conta resumos pendentes, sem marcar entrega. Isso não adiciona uma fila automática de retentativas: o mecanismo atual registra hits antes de enviar e não reenvia esses hits em uma nova avaliação.

A leitura filtrada valida o ID, mantém paginação no banco e exige `owner_id` na mesma consulta. O filtro nunca concede acesso ao alerta de outro usuário. O service worker navega a aba existente para o destino do push antes de colocá-la em foco.

## Critérios de aceite e validação

1. Dez lotes no mesmo alerta/coleta geram uma mensagem por canal/destinatário, com quantidade 10 e todos os hits preservados.
2. Dois alertas com o mesmo nome geram resumos distintos; usuários diferentes não compartilham resultados ou aparelhos.
3. Um lote usa singular; nenhuma novidade não envia aviso.
4. Reavaliação de hits existentes não gera novo resumo; mais de 50 novidades não são truncadas.
5. Push sem aparelho ou com todas as entregas falhando não marca hits como entregues; um aparelho com sucesso marca o grupo.
6. SMTP ausente ou com falha deixa o resumo pendente; e-mail inclui os lotes, texto simples e HTML escapado.
7. O destino do push filtra pelo alerta, preservando autenticação, dono e paginação. A marcação de vistos usa o mesmo filtro de dono.

Testes automatizados: `scripts/teste-alertas-agrupados.ts` e contrato HTTP em `scripts/teste-host-contrato.mjs`, incluídos em `npm run test:isolated`. Verificação de tipos de backend e frontend, build de ambos e teste do contrato compilado complementam a validação. Os testes de entrega usam dependências simuladas e não enviam mensagens reais.

## Evolução possível

Para consolidar coletas de várias fontes em um aviso único por janela, adicionar outbox persistente e job de entrega com intervalo definido pelo produto. Isso deve tratar concorrência, retentativas, cancelamento de alertas e idade dos lotes antes de prometer entrega automática de pendências.
