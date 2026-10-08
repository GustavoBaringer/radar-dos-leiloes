-- Cadastro de assinante (substitui a lista de espera como CTA da landing).
--
-- Dado de cartão NUNCA entra aqui: o pagamento acontece na fatura/checkout
-- hospedado do ASAAS, e só os ids que ele devolve (customer, subscription)
-- ficam guardados. O consentimento vai junto com o texto que a pessoa leu,
-- pelo mesmo motivo da tabela `espera`: provar a base legal depois.
-- gen_random_uuid() é nativo desde o Postgres 13, sem pgcrypto.
CREATE TABLE IF NOT EXISTS cadastros (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                    text NOT NULL,
  cpf_cnpj                text NOT NULL,
  tipo_documento          text NOT NULL CHECK (tipo_documento IN ('CPF','CNPJ')),
  email                   text NOT NULL,
  celular                 text NOT NULL,
  status                  text NOT NULL DEFAULT 'pendente_pagamento'
    CHECK (status IN ('pendente_pagamento','aguardando_confirmacao','ativo','inadimplente','cancelado','estornado')),
  plano                   text NOT NULL DEFAULT 'mensal',
  valor_mensal            numeric(10,2) NOT NULL DEFAULT 69.90,
  asaas_customer_id       text UNIQUE,
  asaas_subscription_id   text UNIQUE,
  consentimento_termos_em timestamptz NOT NULL,
  consentimento_versao    text NOT NULL,
  consentimento_texto     text NOT NULL,
  consentimento_ip        text,
  consentimento_marketing boolean NOT NULL DEFAULT false,
  origem                  text,
  criado_em               timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cadastros_cpf_cnpj_uk ON cadastros (cpf_cnpj);
CREATE UNIQUE INDEX IF NOT EXISTS cadastros_email_uk ON cadastros (email);
CREATE INDEX IF NOT EXISTS cadastros_status_idx ON cadastros (status);
