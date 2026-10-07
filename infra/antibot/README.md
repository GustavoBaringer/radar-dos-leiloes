# Antibot — preparação de infraestrutura (INERTE)

Estes arquivos são **exemplos para uma VPS futura**. Não copiar para diretórios ativos, não executar nem habilitar. Não há VPS, certificados, chaves ou estratégia de proteção da origem provisionados; portanto a publicação permanece bloqueada.

## Dependências para qualquer publicação futura

O operador precisa obter VPS e acesso autorizado ao DNS/Cloudflare, decidir e comprovar uma estratégia que impeça acesso direto à origem/CDN-bypass, definir e verificar a procedência dos proxies confiáveis, provisionar certificados/chaves reais e configurar Redis privado. `ANTIBOT_ORIGIN_PROTECTION_CONFIRMED=1` é apenas ACK manual, nunca evidência dessa proteção. Nginx requer arquivo de IPs Cloudflare confiáveis fornecido e verificado pelo operador; este repositório não o fornece. Não escolher ou aplicar aqui firewall, mTLS ou outra estratégia de origem.

## Arquivos

- `nginx.conf.example`: modelo TLS para `radardeleiloes.app.br` e `www.radardeleiloes.app.br`, upstream somente `127.0.0.1:4500`; sobrescreve `X-Forwarded-For` com `$remote_addr` (não confia no valor enviado pelo cliente). Certificados e include de IPs confiáveis são dependências externas obrigatórias.
- `redis.conf.example`: instância antibot futura separada na porta loopback 6381, limite 128 MiB, `noeviction` e AOF. `BullMQ` na 6380 fica intocado. Arquivo privado de ACL/senha é obrigatório e não fornecido.
- `radar.service.example`: referência de unidade systemd, não instalada/habilitada.
- `production.env.example`: perfil propositalmente incompleto: modos `enforce`; chaves e ACKs vazios impedem configuração válida. Redis antibot separado deve receber URL autenticada privada. Nunca ler/copiar `.env` existente ou segredos reais.
- `cloudflare-rules.md`: proposta condicional, não regra aplicada. Confirmar capacidades do plano antes de considerar qualquer ação; não usar managed challenge em APIs JSON.

## Runbook futuro (manual, somente VPS)

1. Antes de publicar, validar a inacessibilidade da origem por fora do proxy/CDN, cabeçalhos de cliente forjados, ownership de DNS/cache, certificados, credenciais privadas e plano Cloudflare. Se algum item não puder ser provado, **não publicar**.
2. Fazer rollout inicialmente em `ANTIBOT_MODE=shadow` com limites/quota explicitamente acordados e observação de contadores; revisar impacto e ajustar com dados medidos. Challenge é independente: começar em `ANTIBOT_CHALLENGE_MODE=off` somente com `ANTIBOT_CHALLENGE_ALLOW_OFF=1` explícito e chaves reais provisionadas antes de habilitar `enforce`. Não prometer capacidades de bot-score/rate limit sem confirmar plano.
3. Após revisão, habilitar quotas `enforce` e challenge `enforce` separadamente, um por vez. Requer ACK de origem (`ANTIBOT_ORIGIN_PROTECTION_CONFIRMED=1`) somente após prova independente. Não misturar ACK com evidência técnica.
4. Observar 429/503, fallback/degradação Redis, latência de verificação, WS/conexões, memória/OOM e respostas JSON. Indicadores de admin são locais ao processo; não representam totais multi-instância. Proteger `/api/security/metrics` com autenticação/admin já existente; sem exposição pública.
5. Em degradação, investigar Redis, AOF, limite/noeviction e leases/fallback: orçamento local documentado de fallback 60 operações/60s e 2 leases; Redis indisponível pode produzir 503, e memória limitada/noeviction pode recusar writes. Avaliar risco de quota/latência com tráfego real, sem inventar SLO ou baseline.

### Rollback futuro

Alterar modos para `off` somente com ACK explícito correspondente (`ANTIBOT_ALLOW_OFF=1` para quota e `ANTIBOT_CHALLENGE_ALLOW_OFF=1` para challenge), limpar o ACK de origem para vazio quando a origem deixar de estar protegida e reiniciar manualmente na VPS. Restaurar o artefato/configuração anterior versionada se necessário; comparar 429/503, latência, memória/OOM e estado Redis com baseline medido. **Não** executar `FLUSH*`, apagar quotas, deletar chaves ou limpar dados como rollback. Esta documentação não autoriza comandos no host empresarial.

Capacidades de Cloudflare, baseline, limiares aceitáveis e estratégia de origem são decisões/medições pendentes do operador. Esta entrega não está implantada nem pronta para publicação.
