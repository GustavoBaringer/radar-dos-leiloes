-- Lista de espera da landing.
--
-- Guardar e-mail de terceiro tem finalidade declarada e prazo: a pessoa pede
-- para ser avisada quando a conta abrir. Por isso a tabela registra o consentimento
-- (o texto que ela leu) junto com o dado, e não só o dado — sem isso não há como
-- provar a base legal depois. `origem` separa quem veio da landing de quem
-- vier de outra campanha.
CREATE TABLE IF NOT EXISTS espera (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL,
  nome          text,
  interesse     text,
  origem        text NOT NULL DEFAULT 'landing',
  consentimento text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- O mesmo e-mail não entra duas vezes: o formulário reenviado é o caso comum,
-- e duplicata vira dois avisos para a mesma pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS espera_email_uk ON espera (lower(email));
