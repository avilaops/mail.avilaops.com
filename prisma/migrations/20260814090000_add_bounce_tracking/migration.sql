-- Marca quando o remetente foi avisado da falha de entrega (DSN).
-- Coluna anulavel de proposito: as linhas antigas ficam NULL e nao disparam
-- aviso retroativo para mensagens que ja falharam ha dias.
ALTER TABLE "mail_outbound" ADD COLUMN "bounced_at" TIMESTAMP(3);
