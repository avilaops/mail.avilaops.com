-- CardDAV/CalDAV: contatos e agenda sincronizaveis. Exclusao vira lapide
-- (deleted_at) com seq novo — o sync-collection precisa contar o que sumiu.
ALTER TABLE "mail_mailboxes" ADD COLUMN "dav_contacts_seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "mail_mailboxes" ADD COLUMN "dav_calendar_seq" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "mail_dav_items" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "etag" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "display_name" TEXT,
    "dt_start" TIMESTAMP(3),
    "dt_end" TIMESTAMP(3),
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "seq" BIGINT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_dav_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_dav_items_mailbox_id_collection_href_key"
    ON "mail_dav_items"("mailbox_id", "collection", "href");
CREATE INDEX "mail_dav_items_mailbox_id_collection_seq_idx"
    ON "mail_dav_items"("mailbox_id", "collection", "seq");

ALTER TABLE "mail_dav_items"
    ADD CONSTRAINT "mail_dav_items_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
