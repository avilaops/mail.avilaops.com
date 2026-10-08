-- Regras de triagem por caixa (Fase 6). Avaliadas na entrega, na ordem de
-- "position"; a primeira que casa decide. Condicoes e acoes ficam em JSONB
-- porque o formato e pequeno, versionado pelo codigo e nunca consultado por
-- indice — coluna por condicao seria migracao nova a cada campo suportado.
CREATE TABLE "mailbox_rules" (
    "id" TEXT NOT NULL,
    "mailbox_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "match" TEXT NOT NULL DEFAULT 'all',
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mailbox_rules_mailbox_id_position_idx" ON "mailbox_rules"("mailbox_id", "position");

ALTER TABLE "mailbox_rules" ADD CONSTRAINT "mailbox_rules_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mail_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
