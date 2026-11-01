ALTER TABLE "mail_sessions"
  ADD COLUMN "family_id" TEXT,
  ADD COLUMN "replacement_refresh" TEXT;

CREATE INDEX "mail_sessions_family_id_idx" ON "mail_sessions"("family_id");
