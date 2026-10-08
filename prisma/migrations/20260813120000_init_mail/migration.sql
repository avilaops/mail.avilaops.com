-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "mail_domains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_dns',
    "dkim_selector" TEXT NOT NULL DEFAULT 'avila',
    "dkim_private_key" TEXT,
    "dkim_public_key" TEXT,
    "dns_check" JSONB,
    "dns_checked_at" TIMESTAMP(3),
    "catch_all_mailbox_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_mailboxes" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "local_part" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "quota_bytes" BIGINT NOT NULL DEFAULT 5368709120,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "send_limit_per_hour" INTEGER NOT NULL DEFAULT 200,
    "recovery_email" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_sessions" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "refresh_hash" TEXT NOT NULL,
    "user_agent" VARCHAR(300),
    "ip" VARCHAR(60),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_login_attempts" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mail_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_aliases" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "local_part" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_folders" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "uid_validity" INTEGER NOT NULL DEFAULT 1,
    "uid_next" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "folder_id" TEXT NOT NULL,
    "rfc_message_id" TEXT,
    "in_reply_to" TEXT,
    "thread_key" TEXT,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "to_addresses" JSONB NOT NULL DEFAULT '[]',
    "cc_addresses" JSONB NOT NULL DEFAULT '[]',
    "reply_to" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT,
    "snippet" VARCHAR(320),
    "body_text" TEXT,
    "body_html" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "auth_result" JSONB,
    "spam_score" DOUBLE PRECISION,
    "quarantine_reason" TEXT,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "uid" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "filename" TEXT,
    "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size_bytes" INTEGER NOT NULL,
    "content_id" TEXT,
    "part_index" INTEGER NOT NULL,

    CONSTRAINT "mail_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_outbound" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT,
    "envelope_from" TEXT NOT NULL,
    "recipients" JSONB NOT NULL,
    "subject" TEXT,
    "storage_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "relay_driver" TEXT,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_outbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_events" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT,
    "mailbox_id" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_mailbox_settings" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "signature_html" TEXT,
    "signature_text" TEXT,
    "auto_reply_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_reply_subject" TEXT,
    "auto_reply_body" TEXT,
    "auto_reply_until" TIMESTAMP(3),
    "show_remote_images" BOOLEAN NOT NULL DEFAULT false,
    "messages_per_page" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_mailbox_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_auto_reply_log" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_auto_reply_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_pending_attachments" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_pending_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_password_reset_tokens" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_billing_accounts" (
    "id" TEXT NOT NULL,
    "client_ref" TEXT NOT NULL,
    "payer_email" TEXT NOT NULL,
    "payer_name" TEXT,
    "preapproval_id" TEXT,
    "init_point" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_card',
    "unit_price_cents" INTEGER NOT NULL DEFAULT 1000,
    "mailbox_count" INTEGER NOT NULL DEFAULT 0,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "next_charge_at" TIMESTAMP(3),
    "last_payment_at" TIMESTAMP(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "suspended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_billing_payments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "status_detail" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_billing_events" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "notification_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_send_counters" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mail_send_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_domains_name_key" ON "mail_domains"("name");

-- CreateIndex
CREATE INDEX "mail_domains_status_idx" ON "mail_domains"("status");

-- CreateIndex
CREATE INDEX "mail_mailboxes_status_idx" ON "mail_mailboxes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mail_mailboxes_domain_id_local_part_key" ON "mail_mailboxes"("domain_id", "local_part");

-- CreateIndex
CREATE UNIQUE INDEX "mail_sessions_refresh_hash_key" ON "mail_sessions"("refresh_hash");

-- CreateIndex
CREATE INDEX "mail_sessions_mailbox_id_expires_at_idx" ON "mail_sessions"("mailbox_id", "expires_at");

-- CreateIndex
CREATE INDEX "mail_login_attempts_window_start_idx" ON "mail_login_attempts"("window_start");

-- CreateIndex
CREATE UNIQUE INDEX "mail_login_attempts_identifier_window_start_key" ON "mail_login_attempts"("identifier", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "mail_aliases_domain_id_local_part_key" ON "mail_aliases"("domain_id", "local_part");

-- CreateIndex
CREATE UNIQUE INDEX "mail_folders_mailbox_id_name_key" ON "mail_folders"("mailbox_id", "name");

-- CreateIndex
CREATE INDEX "mail_messages_mailbox_id_folder_id_received_at_idx" ON "mail_messages"("mailbox_id", "folder_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "mail_messages_mailbox_id_seen_idx" ON "mail_messages"("mailbox_id", "seen");

-- CreateIndex
CREATE INDEX "mail_messages_mailbox_id_thread_key_idx" ON "mail_messages"("mailbox_id", "thread_key");

-- CreateIndex
CREATE INDEX "mail_messages_mailbox_id_rfc_message_id_idx" ON "mail_messages"("mailbox_id", "rfc_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_folder_id_uid_key" ON "mail_messages"("folder_id", "uid");

-- CreateIndex
CREATE INDEX "mail_attachments_message_id_idx" ON "mail_attachments"("message_id");

-- CreateIndex
CREATE INDEX "mail_outbound_status_next_attempt_at_idx" ON "mail_outbound"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "mail_outbound_mailbox_id_created_at_idx" ON "mail_outbound"("mailbox_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mail_events_type_created_at_idx" ON "mail_events"("type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mail_events_domain_id_created_at_idx" ON "mail_events"("domain_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mail_mailbox_settings_mailbox_id_key" ON "mail_mailbox_settings"("mailbox_id");

-- CreateIndex
CREATE INDEX "mail_auto_reply_log_sent_at_idx" ON "mail_auto_reply_log"("sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_auto_reply_log_mailbox_id_sender_key" ON "mail_auto_reply_log"("mailbox_id", "sender");

-- CreateIndex
CREATE INDEX "mail_pending_attachments_mailbox_id_created_at_idx" ON "mail_pending_attachments"("mailbox_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_password_reset_tokens_token_hash_key" ON "mail_password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mail_password_reset_tokens_mailbox_id_idx" ON "mail_password_reset_tokens"("mailbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_billing_accounts_client_ref_key" ON "mail_billing_accounts"("client_ref");

-- CreateIndex
CREATE UNIQUE INDEX "mail_billing_accounts_preapproval_id_key" ON "mail_billing_accounts"("preapproval_id");

-- CreateIndex
CREATE INDEX "mail_billing_accounts_status_idx" ON "mail_billing_accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mail_billing_payments_external_id_key" ON "mail_billing_payments"("external_id");

-- CreateIndex
CREATE INDEX "mail_billing_payments_account_id_created_at_idx" ON "mail_billing_payments"("account_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mail_billing_events_notification_id_key" ON "mail_billing_events"("notification_id");

-- CreateIndex
CREATE INDEX "mail_billing_events_topic_created_at_idx" ON "mail_billing_events"("topic", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mail_send_counters_mailbox_id_window_start_key" ON "mail_send_counters"("mailbox_id", "window_start");

-- AddForeignKey
ALTER TABLE "mail_mailboxes" ADD CONSTRAINT "mail_mailboxes_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "mail_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_sessions" ADD CONSTRAINT "mail_sessions_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "mail_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_folders" ADD CONSTRAINT "mail_folders_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "mail_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_attachments" ADD CONSTRAINT "mail_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_outbound" ADD CONSTRAINT "mail_outbound_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_events" ADD CONSTRAINT "mail_events_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "mail_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_events" ADD CONSTRAINT "mail_events_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_mailbox_settings" ADD CONSTRAINT "mail_mailbox_settings_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_auto_reply_log" ADD CONSTRAINT "mail_auto_reply_log_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_pending_attachments" ADD CONSTRAINT "mail_pending_attachments_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_password_reset_tokens" ADD CONSTRAINT "mail_password_reset_tokens_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_billing_payments" ADD CONSTRAINT "mail_billing_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_billing_events" ADD CONSTRAINT "mail_billing_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_billing_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

