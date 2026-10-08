-- Assinaturas de Web Push: um registro por navegador/aparelho que autorizou
-- aviso de mensagem nova. O endpoint e unico porque e ele que identifica a
-- inscricao no servico de push; reinscrever o mesmo navegador atualiza a linha
-- em vez de duplicar avisos.
CREATE TABLE "mail_push_subscriptions" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" VARCHAR(300),
    "last_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_push_subscriptions_endpoint_key" ON "mail_push_subscriptions"("endpoint");
CREATE INDEX "mail_push_subscriptions_mailbox_id_idx" ON "mail_push_subscriptions"("mailbox_id");

ALTER TABLE "mail_push_subscriptions" ADD CONSTRAINT "mail_push_subscriptions_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
