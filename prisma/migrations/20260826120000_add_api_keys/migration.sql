-- Chaves de API da area de desenvolvedor. So o hash e guardado; o token em
-- claro aparece uma vez, na criacao. Revogar marca revoked_at e preserva a
-- linha para auditoria (quem criou, quando usou pela ultima vez).
CREATE TABLE "mail_api_keys" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'mailbox',
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_api_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_api_keys_token_hash_key" ON "mail_api_keys"("token_hash");
CREATE INDEX "mail_api_keys_mailbox_id_idx" ON "mail_api_keys"("mailbox_id");

ALTER TABLE "mail_api_keys" ADD CONSTRAINT "mail_api_keys_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
