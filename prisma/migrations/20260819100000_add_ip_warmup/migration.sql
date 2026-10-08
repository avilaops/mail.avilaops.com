-- Aquecimento de IP: a fila passa a saber quantos destinatarios de cada
-- mensagem sao de fora dos nossos dominios — e o que o teto diario conta.
ALTER TABLE "mail_outbound" ADD COLUMN "external_recipients" INTEGER NOT NULL DEFAULT 0;

-- A soma "quanto ja saiu hoje" roda a cada ciclo da fila.
CREATE INDEX "mail_outbound_sent_at_idx" ON "mail_outbound"("sent_at");
