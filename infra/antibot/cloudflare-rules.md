# Proposta de regras Cloudflare — não aplicada

Somente avaliar após confirmar no plano contratado quais recursos existem (WAF/custom rules, rate limiting, verified bots/bot score e exceções). Não presumir nem prometer score, rate limit ou challenge disponível.

- Preservar acesso de verified bots/SEO às páginas públicas e assets estáticos; não aplicar challenge genérico a crawlers verificados.
- Não aplicar managed challenge a endpoints JSON (`/api/*`), em especial login/cadastro/espera: a aplicação deve responder 429/503 como JSON com status/cabeçalhos coerentes. Challenge Turnstile explícito da aplicação é independente.
- Revisar cache para respostas autenticadas/privadas e `/api/security/metrics`; não cachear segredos ou DTOs privados.
- Fazer exceções e limites somente após medir baseline e verificar semântica/capacidades do plano. Registrar regras, escopo, proprietário e rollback antes de qualquer ativação na VPS.

Nenhuma zona, DNS, regra, API Cloudflare, token ou origem é alterada por este arquivo.
