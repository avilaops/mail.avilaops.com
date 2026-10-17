CREATE TABLE "mail_calendar_invite_deliveries" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "recipients" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "ical" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "outbound_id" TEXT,
    CONSTRAINT "mail_calendar_invite_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_calendar_invite_deliveries_dedupe_key_key"
ON "mail_calendar_invite_deliveries"("dedupe_key");

CREATE INDEX "mail_calendar_invite_deliveries_status_next_attempt_at_idx"
ON "mail_calendar_invite_deliveries"("status", "next_attempt_at");

CREATE INDEX "mail_calendar_invite_deliveries_mailbox_id_delivered_at_idx"
ON "mail_calendar_invite_deliveries"("mailbox_id", "delivered_at");

ALTER TABLE "mail_calendar_invite_deliveries"
ADD CONSTRAINT "mail_calendar_invite_deliveries_mailbox_id_fkey"
FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mail_outbound" ADD COLUMN "source_key" TEXT;
CREATE UNIQUE INDEX "mail_outbound_source_key_key" ON "mail_outbound"("source_key");
