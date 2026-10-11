---
name: investigar-lotes
description: Investiga por que lotes estão ausentes ou mal mapeados, começando por pelo menos uma URL pública de leilão fornecida pelo usuário. Use para comparar catálogo, páginas de lote, parser, filtros e cobertura; coleta com gravação exige autorização explícita.
---

# Investigar lotes

Investigue o fluxo real antes de mudar parser ou afirmar cobertura. Resposta e relatório em português. Comece por pelo menos uma URL `http://` ou `https://` fornecida pelo usuário.

## Entrada e limites

- Se não houver URL de leilão, pergunte imediatamente qual URL investigar. Não adivinhe URLs, domínios, IDs de leilão ou endpoints.
- Aceite páginas públicas. Não envie credenciais, contorne login, WAF, CAPTCHA, rate limit, controles anti-bot ou restrições de acesso. Não faça requisições para hosts internos/intranet nem use dados secretos.
- Padrão: análise somente leitura. Navegação/fetch público pode ser feito com parcimônia; não execute coleta que grava no banco, migração, worker ou rotação global sem autorização explícita para essa coleta.
- Nunca iniciar túnel, proxy, VPN, port forwarding ou serviço de publicação. Não instalar dependências nem interromper processos existentes.
- Não faça commit ou push automaticamente; só mediante pedido explícito.

## Roteiro baseado em evidência

1. **Fixe a evidência.** Registre URL, horário, host final após redirect, status HTTP e método de acesso. Identifique o leiloeiro/evento pela própria URL e HTML, não por inferência de ID. Por exemplo, `131026VT1` é o edital alfanumérico de Lance Certo; não substitua por um `LeilaoCod` numérico suposto.
2. **Comece na página exata do usuário.** Compare home, filtros/catálogo público e detalhe de lote. Um `200` no detalhe público invalida a suposição de que o site inteiro exige login. Um template oculto `TESTEVIP`, stub JS, resposta de uma rota AJAX ou um único `403` não prova login obrigatório nem ausência de lotes. Não exclua o site inteiro por esses sinais.
3. **Siga a navegação observada.** Descubra links de categoria, paginação e submissões/forms no HTML ou JS entregue. Verifique destinos reais no browser/rede pública quando necessário. Não invente endpoint, query parameter ou sequência de páginas. Considere duplicatas como raiz e `?pag=1`; evite limite global de páginas que esgote categorias iniciais antes das posteriores.
4. **Compare contagens com denominadores explícitos:** itens anunciados; cards/candidatos únicos vistos; candidatos elegíveis após exclusões; lotes mapeados; linhas gravadas; novos IDs inseridos. Esses números não são intercambiáveis. Uma página curta ou catálogo truncado não é “zero lotes” nem cobertura completa.
5. **Inspecione contrato e normalização.** Use HTML/JSON real e tipo canônico existente. Preserve IDs/URLs da fonte, título e categoria ampla, subcategoria, status, data/hora e valor. Reutilize classificadores/filtros existentes. Datas locais brasileiras normalmente precisam conversão explícita para UTC; valide com data conhecida. Não force status aberto, não trate categoria genérica como veículo e não transforme equipamento médico em carro. Equipamento médico pode ser um bem legítimo, mas se o esquema/filtro global o rejeita como `outro`, reporte esse limite sem alterar política global ou inventar tipo.
6. **Distingua ausência de falha.** Amostre pelo menos um positivo conhecido e exemplifique exclusões reais (template demo, coleção, peça/sucata ou tipo fora de escopo). Em falha de fetch/parser, volume não percorrido, paginação desconhecida ou contagem divergente, reporte cobertura parcial/desconhecida e a causa; nunca apresente HTML vazio como prova de catálogo vazio.
7. **Só depois proponha o menor reparo.** Corrija a causa comum ao fluxo, mantendo o escopo pedido. Se a origem/contrato ainda não estiver comprovado, pare na investigação e peça evidência em vez de criar conector/endpoints especulativos.

## Verificação

- Antes de persistir, crie/ajuste fixture durável do fluxo real: positivo conhecido, ordem das categorias, paginação/duplicação, exclusão demo, schema inesperado e cancelamento/falha quando aplicável. Não dependa de `/tmp` para testes permanentes.
- Para coleta autorizada, prefira a execução manual single-tenant e um limite explícito. Não rode `collect` global, worker, scheduler ou rotação ampla para investigar um host.
- Antes da coleta persistente, capture contagem baseline por `lots.lot_url`/host normalizado (ou filtro explícito do tenant), instante UTC e amostra de IDs/URLs existentes. Não use join com `auctioneer_registry` para deduzir host; não use `first_seen` diário como baseline.
- Após execução, valide run ID, domínio realmente coletado, URLs/hosts persistidos, contagem antes/depois e IDs de inserção novos. `upserted` pode incluir atualizações; não é sinônimo de novos lotes. Não aceite redirect para outro host como coleta do tenant solicitado.
- Relate separadamente lidos, mapeados, gravados/atualizados, novos IDs e descartados com razões. Se a execução não ocorreu, use “não executado”, nunca zero. Não fabrique output de ferramenta nem números de coleta.
- Casos locais úteis: Home Lance Certo → filtros públicos; imóvel `https://www.lancecertoleiloes.com.br/leilao/131026VT1/lote/935554`; no filtro, template demo versus cards reais. Contagens observadas nesta sessão, como 951 lotes mapeados ou 49 cards anunciados, não são expectativas fixas para consultas futuras.
- Mudança de domínio exige proveniência. Por exemplo, `Leilões Brasil` não deve ser confundido com domínio antigo de PE; exclua Albuquerque/antiguidades ou casos JUCE-000 apenas com evidência específica, sem banir um site inteiro por semelhança de demo.

## Relatório final

Inclua URL e domínio testados, instante, acesso/status, escopo efetivamente percorrido, denominador/contagens, positivo conhecido, descartes e motivo, limitações e comandos executados. Separe ativos/históricos e contagem anunciada de lotes mapeados. Declare se houve gravação; se houve, mostre baseline, resultado e novos IDs. Termine com próximo passo verificável. Não alegue reload/validação do host sem output real.

Para coleta autorizada, apresente no chat a tabela: `Domínio | Antes | Depois | Ganho | Lidos | Mapeados | Gravados/atualizados | Novos | Descartados | Cobertura/motivo`. Arquivos são evidência adicional, não substituem a tabela solicitada.

## Exemplos de uso

- `@investigar-lotes https://www.lancecertoleiloes.com.br/leilao/131026VT1/lote/935554`
- `@investigar-lotes https://www.lancecertoleiloes.com.br/filtro/imoveis`
- Para uma coleta com gravação, peça confirmação explícita do tenant e limite antes de executar.
