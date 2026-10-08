-- Cadastro self-service: o pedido existe ANTES do domínio e da caixa.
--
-- É o que permite inverter a ordem "cria e depois cobra". Aberto ao público,
-- aquela ordem dá caixa de graça para qualquer um: aqui o pedido fica parado
-- em `aguardando_pagamento` e só vira domínio + caixa quando o Mercado Pago
-- confirma a assinatura.
CREATE TABLE "mail_signups" (
  "id"               TEXT PRIMARY KEY,
  -- Token opaco que o navegador carrega para consultar o próprio pedido. Não
  -- usamos o id: quem descobre um id não pode ler o pedido dos outros.
  "token"            TEXT NOT NULL,
  "domain"           TEXT NOT NULL,
  "payer_email"      TEXT NOT NULL,
  "payer_name"       TEXT,
  "local_part"       TEXT NOT NULL,
  "mailbox_count"    INTEGER NOT NULL DEFAULT 1,
  "unit_price_cents" INTEGER NOT NULL,
  -- Referência de cobrança. Nasce sintética (`auto:<token>`) porque no
  -- self-service ainda não existe cliente no portal quando o pedido é criado.
  "client_ref"       TEXT NOT NULL,
  "preapproval_id"   TEXT,
  "init_point"       TEXT,
  -- aguardando_pagamento | pago | provisionado | expirado | falhou
  "status"           TEXT NOT NULL DEFAULT 'aguardando_pagamento',
  "erro"             TEXT,
  "ip"               TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "provisioned_at"   TIMESTAMP(3)
);

CREATE UNIQUE INDEX "mail_signups_token_key" ON "mail_signups"("token");
CREATE UNIQUE INDEX "mail_signups_client_ref_key" ON "mail_signups"("client_ref");
CREATE UNIQUE INDEX "mail_signups_preapproval_id_key" ON "mail_signups"("preapproval_id");
CREATE INDEX "mail_signups_domain_idx" ON "mail_signups"("domain");
CREATE INDEX "mail_signups_status_idx" ON "mail_signups"("status");

-- Freio de novato: caixa nascida no self-service envia pouco nos primeiros
-- dias. Quem compra e-mail para disparar spam some antes de a rampa acabar, e
-- a reputação do nosso IP é compartilhada com todos os clientes de casa.
ALTER TABLE "mail_mailboxes" ADD COLUMN "probation_until" TIMESTAMP(3);
