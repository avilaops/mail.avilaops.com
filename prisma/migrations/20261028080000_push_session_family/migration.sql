ALTER TABLE "mail_sessions" ADD COLUMN "notifications_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_push_subscriptions" ADD COLUMN "family_id" TEXT;
CREATE INDEX "mail_push_subscriptions_family_id_idx" ON "mail_push_subscriptions"("family_id");
ALTER TABLE "mail_push_subscriptions" ADD CONSTRAINT "mail_push_subscriptions_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "mail_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- As inscricoes antigas nao possuem prova de autorizacao ligada a uma sessao.
-- Apagar tambem as chaves evita conserva-las sem finalidade apos a migracao.
DELETE FROM "mail_push_subscriptions";
