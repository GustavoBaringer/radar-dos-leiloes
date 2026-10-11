-- Ajustes de discovered_sites para a VPS rodar na agenda diaria (7h, 13h, 18h).
-- Idempotente: pode rodar quantas vezes quiser.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/vps-discovered-sites.sql
--
-- Contexto: a agenda escolhe tenants por `platform` + `http_status = 200` +
-- `has_lots IS NOT FALSE`. Sites ja coletados que a sonda marcou errado
-- ficavam de fora. O commit 7b1e2d1 faz a sonda se autocorrigir na semana
-- seguinte; estas consultas aplicam o efeito agora.

BEGIN;

-- 1) Sites com lotes ja coletados que a sonda marcou como "sem lotes".
--    A sonda so le a home; sites que expoem lotes em outra rota davam falso
--    negativo e caavam fora do filtro da agenda.
UPDATE discovered_sites
   SET has_lots = true, checked_at = now()
 WHERE lower(domain) IN ('ccjleiloes.com.br',
                         'ricoleiloes.com.br',
                         'leilaopernambuco.com.br',
                         'lilianportugal.com.br')
   AND has_lots IS NOT TRUE;

-- 2) Atlantico respondia 403 para a sonda, mas tem catalogo coletado.
UPDATE discovered_sites
   SET http_status = 200, has_lots = true, checked_at = now()
 WHERE lower(domain) = 'atlanticoleiloes.com.br'
   AND http_status IS DISTINCT FROM 200;

-- 3) Dois sites com lotes coletados que nunca entraram na descoberta.
--    Ambos usam o padrao /eventos/leilao/ da plataforma Suporte.
INSERT INTO discovered_sites (domain, platform, http_status, has_lots, title, note)
VALUES
 ('compreipgfn.com.br', 'suporte-leiloes', 200, true, 'PGFN - Compromisso',
  'lotes coletados por htmlagenda; ausente na descoberta'),
 ('aplleiloes.com.br', 'suporte-leiloes', 200, true, 'APL Leiloes',
  'lotes coletados por htmlagenda; ausente na descoberta')
ON CONFLICT (domain) DO UPDATE
   SET has_lots = true,
       platform = COALESCE(discovered_sites.platform, 'suporte-leiloes'),
       checked_at = now();

COMMIT;

-- Relatorio: o que a agenda vai enxergar agora.
\echo ''
\echo '== Sites das listas de PE/SE/PB na agenda =='
WITH alvos(domain) AS (VALUES
  ('lancecertoleiloes.com.br'), ('leiloesfreire.com.br'), ('cassianoleiloes.com.br'),
  ('gracieleiloes.com.br'), ('leilaopernambuco.com.br'), ('rjleiloes.com.br'),
  ('ghvmleiloes.com.br'), ('inovaleilao.com.br'), ('flaviocostaleiloes.com.br'),
  ('aragaoleiloes.com.br'), ('coliseumleiloes.com.br'), ('jdleiloes.com.br'),
  ('albuquerqueleiloes.com.br'), ('portaldosleiloes.com.br'), ('ericosobral.com.br'),
  ('colodeteleiloes.com.br'), ('joserodovalholeiloes.com.br'), ('leiloesbrasilpe.com.br'),
  ('patiorochaleiloes.com.br'), ('vlleiloes.com.br'), ('realizaleiloes.com.br'),
  ('c3leiloes.com.br'), ('abaleiloes.com.br'), ('lancese.com.br'),
  ('argleiloes.com.br'), ('marcotulioleiloes.com.br'), ('leiloescostaesilva.com.br'),
  ('tbaracajuleiloes.com.br'), ('fabiobarbosaleiloes.com.br'), ('leiloespb.com.br'),
  ('colossoleiloes.com.br'), ('atlanticoleiloes.com.br'), ('vlleiloes.com.br'),
  ('maglianoleiloes.com.br'), ('leiloesmonteiro.com.br'), ('focoleiloes.com.br'),
  ('celsocunhaleiloes.com.br'), ('ccjleiloes.com.br')
)
SELECT d.domain, d.platform, d.http_status, d.has_lots,
       CASE WHEN d.http_status = 200 AND d.has_lots IS NOT FALSE
            THEN 'ok' ELSE 'FORA DA AGENDA' END AS situacao
  FROM alvos a
  LEFT JOIN discovered_sites d ON lower(d.domain) = a.domain
 ORDER BY a.domain;

\echo ''
\echo '== Total de tenants elegiveis por plataforma =='
SELECT platform, count(*) AS tenants
  FROM discovered_sites
 WHERE http_status = 200 AND has_lots IS NOT FALSE
 GROUP BY platform ORDER BY tenants DESC;