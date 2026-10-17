-- Piso de sync preservado depois da remocao de lapides antigas.
ALTER TABLE "mail_mailboxes"
  ADD COLUMN "dav_contacts_min_seq" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "dav_calendar_min_seq" BIGINT NOT NULL DEFAULT 0;
