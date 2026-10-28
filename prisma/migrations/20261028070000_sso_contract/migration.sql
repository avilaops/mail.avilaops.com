ALTER TABLE "mail_sessions"
  ADD COLUMN "sso_subject" TEXT,
  ADD COLUMN "sso_email" TEXT,
  ADD COLUMN "sso_issued_at" TIMESTAMP(3),
  ADD COLUMN "sso_token" TEXT;

CREATE INDEX "mail_sessions_sso_subject_idx" ON "mail_sessions"("sso_subject");

CREATE TABLE "mail_sso_revocations" (
  "subject" TEXT NOT NULL PRIMARY KEY,
  "revoked_before" TIMESTAMP(3) NOT NULL
);
