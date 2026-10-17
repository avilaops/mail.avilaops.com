CREATE TABLE "mail_calendars" (
  "id" TEXT NOT NULL,
  "mailbox_id" TEXT NOT NULL,
  "href" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#2563EB',
  "position" INTEGER NOT NULL DEFAULT 0,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "seq" BIGINT NOT NULL DEFAULT 0,
  "min_seq" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mail_calendars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mail_calendars_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mail_calendars_mailbox_id_name_key" ON "mail_calendars"("mailbox_id", "name");
CREATE UNIQUE INDEX "mail_calendars_mailbox_id_href_key" ON "mail_calendars"("mailbox_id", "href");
CREATE UNIQUE INDEX "mail_calendars_one_default_per_mailbox" ON "mail_calendars"("mailbox_id") WHERE "is_default" = true;
CREATE INDEX "mail_calendars_mailbox_id_position_idx" ON "mail_calendars"("mailbox_id", "position");

INSERT INTO "mail_calendars" ("id", "mailbox_id", "href", "name", "color", "position", "is_default", "seq", "min_seq")
SELECT 'default-' || "id", "id", 'agenda', 'Agenda', '#2563EB', 0, true, "dav_calendar_seq", "dav_calendar_min_seq"
FROM "mail_mailboxes";

ALTER TABLE "mail_dav_items" ADD COLUMN "calendar_id" TEXT;
UPDATE "mail_dav_items" SET "calendar_id" = 'default-' || "mailbox_id" WHERE "collection" = 'calendar';
ALTER TABLE "mail_dav_items" ADD CONSTRAINT "mail_dav_items_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "mail_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "mail_dav_items_calendar_id_seq_idx" ON "mail_dav_items"("calendar_id", "seq");
DROP INDEX "mail_dav_items_mailbox_id_collection_href_key";
CREATE UNIQUE INDEX "mail_dav_items_contacts_href_key" ON "mail_dav_items"("mailbox_id", "collection", "href") WHERE "calendar_id" IS NULL;
CREATE UNIQUE INDEX "mail_dav_items_calendar_href_key" ON "mail_dav_items"("calendar_id", "href") WHERE "calendar_id" IS NOT NULL;
