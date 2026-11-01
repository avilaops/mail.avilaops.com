ALTER TABLE "mail_mailboxes" ADD COLUMN "message_event_seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "mail_messages" ADD COLUMN "arrival_seq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "mail_messages" ADD COLUMN "notification_kind" TEXT NOT NULL DEFAULT 'none';
CREATE INDEX "mail_messages_mailbox_id_arrival_seq_idx" ON "mail_messages"("mailbox_id", "arrival_seq");
