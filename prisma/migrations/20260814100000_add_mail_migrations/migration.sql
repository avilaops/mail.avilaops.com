-- Migracao assistida: copia a caixa do provedor antigo (Zoho, Titan, Gmail)
-- para ca, por IMAP. Tabela propria porque a copia leva horas e precisa
-- sobreviver a restart do servico.
CREATE TABLE "mail_migrations" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "source_host" TEXT NOT NULL,
    "source_port" INTEGER NOT NULL DEFAULT 993,
    "source_user" TEXT NOT NULL,
    "source_secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "total_messages" INTEGER NOT NULL DEFAULT 0,
    "copied_messages" INTEGER NOT NULL DEFAULT 0,
    "skipped_messages" INTEGER NOT NULL DEFAULT 0,
    "copied_bytes" BIGINT NOT NULL DEFAULT 0,
    "current_folder" TEXT,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_migrations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_migrations_status_created_at_idx" ON "mail_migrations"("status", "created_at");
CREATE INDEX "mail_migrations_mailbox_id_created_at_idx" ON "mail_migrations"("mailbox_id", "created_at" DESC);

ALTER TABLE "mail_migrations" ADD CONSTRAINT "mail_migrations_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
