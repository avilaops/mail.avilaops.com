-- Verificacao em duas etapas (TOTP) do webmail. O segredo fica cifrado
-- (AES-256-GCM, mesma chave das DKIM) e so vale depois que o dono prova um
-- codigo e totp_enabled_at e marcado.
ALTER TABLE "mail_mailboxes" ADD COLUMN "totp_secret" TEXT;
ALTER TABLE "mail_mailboxes" ADD COLUMN "totp_enabled_at" TIMESTAMP(3);
ALTER TABLE "mail_mailboxes" ADD COLUMN "totp_last_counter" INTEGER;
ALTER TABLE "mail_mailboxes" ADD COLUMN "totp_recovery_codes" JSONB;
