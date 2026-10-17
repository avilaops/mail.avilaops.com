CREATE TABLE "mail_calendar_reminder_deliveries" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "occurrence_at" TIMESTAMP(3) NOT NULL,
    "minutes_before" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    CONSTRAINT "mail_calendar_reminder_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_calendar_reminder_deliveries_mailbox_id_uid_occurrence_key"
ON "mail_calendar_reminder_deliveries"("mailbox_id", "uid", "occurrence_at", "minutes_before");

CREATE INDEX "mail_calendar_reminder_deliveries_mailbox_id_delivered_at_idx"
ON "mail_calendar_reminder_deliveries"("mailbox_id", "delivered_at");

CREATE INDEX "mail_calendar_reminder_deliveries_status_next_attempt_at_idx"
ON "mail_calendar_reminder_deliveries"("status", "next_attempt_at");

ALTER TABLE "mail_calendar_reminder_deliveries"
ADD CONSTRAINT "mail_calendar_reminder_deliveries_mailbox_id_fkey"
FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
