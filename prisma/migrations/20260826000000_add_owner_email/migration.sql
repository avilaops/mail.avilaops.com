-- Dono da caixa no SSO (auth.avilaops.com): e-mail da conta em portal_clients.
-- Permite que uma conta Avila Ops possua caixas em varios dominios.
ALTER TABLE "mail_mailboxes" ADD COLUMN "owner_email" TEXT;
CREATE INDEX "mail_mailboxes_owner_email_idx" ON "mail_mailboxes"("owner_email");
