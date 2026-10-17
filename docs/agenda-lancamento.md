# Lançamento da agenda

Este checklist operacional cobre a AVL-61. Nenhuma etapa de produção deve ser executada antes de o módulo completo passar nos testes e ter as telas registradas.

## Antes do deploy

- [ ] Revisar e aprovar o rascunho em `docs/agenda-aviso-clientes.md`.
- [ ] Confirmar `AGENDA_ENABLED=internal` e `AGENDA_INTERNAL_DOMAINS=avilaops.com` no webmail.
- [ ] Confirmar que o workflow `Build e deploy` passou para API e webmail.
- [ ] Fazer dump do PostgreSQL e conferir que o arquivo não está vazio:

  ```bash
  pg_dump --format=custom --file="/var/backups/avila-mail/pre-agenda-$(date -u +%Y%m%dT%H%M%SZ).dump" "$MAIL_DATABASE_URL"
  find /var/backups/avila-mail -name 'pre-agenda-*.dump' -size +0c -print -quit | grep -q .
  ```

## Deploy interno

- [ ] Aplicar `npx prisma migrate deploy` antes de reiniciar a API.
- [ ] Subir API e webmail construídos pelo mesmo workflow.
- [ ] Confirmar API, MTA, webmail e Caddy ativos.
- [ ] Conferir que `/api/v1/*` chega à API, `/api/mail/*` ao BFF e `/dav/*` à API.
- [ ] Executar `npm run test:smoke` no artefato da API em produção.
- [ ] Abrir `/agenda` numa caixa `@avilaops.com` e confirmar criação, edição, exclusão, lembrete e sincronização CalDAV.
- [ ] Conferir os logs sem erro novo:

  ```bash
  systemctl is-active avila-mail-api avila-mail-mta avila-webmail caddy
  journalctl -u avila-mail-api -u avila-webmail --since "15 minutes ago" --priority=err
  curl -fsS http://127.0.0.1:3040/v1/health
  ```

## Liberação geral

- [ ] Manter uso interno sem erro por uma semana.
- [ ] Registrar a caixa, data inicial, data final e resultado da observação.
- [ ] Alterar `AGENDA_ENABLED=all`, reiniciar o webmail e conferir `/agenda` numa caixa de cliente.
- [ ] Após aprovação de Nicolas, enviar o aviso às caixas ativas.

## Reversão

- [ ] Voltar imediatamente `AGENDA_ENABLED=false` se a interface apresentar falha.
- [ ] Preservar os dados de agenda; não reverter migrações destrutivamente.
- [ ] Restaurar o dump apenas em incidente de dados confirmado e com janela de manutenção aprovada.
