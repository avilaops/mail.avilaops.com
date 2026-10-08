-- Treino do anti-spam: os botoes "e spam"/"nao e spam" viram reputacao de
-- remetente por caixa. A decisao mais recente do dono vence.
CREATE TABLE "mail_sender_reputation" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "sender_address" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reports" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_sender_reputation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_sender_reputation_mailbox_id_sender_address_key"
    ON "mail_sender_reputation"("mailbox_id", "sender_address");

ALTER TABLE "mail_sender_reputation"
    ADD CONSTRAINT "mail_sender_reputation_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
