-- Campos que o cadastro do FENAJU traz e o anterior não tinha.
-- `dominio_leilao` é o subdomínio *.leilao.br que a federação atribui a cada
-- leiloeiro: é um vetor de descoberta que não existia.
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS uf_junta       TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS ano_posse      TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS credenciamento TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS associado      BOOLEAN;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS nivel          TEXT;
ALTER TABLE auctioneers ADD COLUMN IF NOT EXISTS dominio_leilao TEXT;
CREATE INDEX IF NOT EXISTS auctioneers_uf ON auctioneers (uf_junta);
CREATE INDEX IF NOT EXISTS auctioneers_dom_leilao ON auctioneers (dominio_leilao);
