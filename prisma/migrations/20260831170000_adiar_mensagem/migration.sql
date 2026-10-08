-- Adiar mensagem: sai da Entrada agora e volta sozinha na hora marcada.
--
-- A coluna e a agenda, do mesmo jeito que next_attempt_at agenda a fila de
-- saida. Nula quer dizer "nao esta adiada", que e o estado de toda mensagem
-- que ja existe — por isso a coluna nasce sem DEFAULT e aceita nulo.
ALTER TABLE "mail_messages" ADD COLUMN "snoozed_until" TIMESTAMP(3);

-- O varredor roda a cada 10s procurando snoozed_until <= agora. Sem indice
-- isso seria varredura da tabela inteira de mensagens a cada tique.
CREATE INDEX "mail_messages_snoozed_until_idx" ON "mail_messages"("snoozed_until");
