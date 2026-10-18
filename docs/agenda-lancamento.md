# Lançamento da agenda

Este checklist operacional cobre a AVL-61. Nenhuma etapa de produção deve ser executada antes de o módulo completo passar nos testes e ter as telas registradas.

## Antes do deploy

- [ ] Revisar e aprovar o rascunho em `docs/agenda-aviso-clientes.md`.
- [x] Confirmar `AGENDA_ENABLED=internal` e `AGENDA_INTERNAL_DOMAINS=avilaops.com` no webmail.
- [x] Confirmar que o workflow `Build e deploy` passou para API e webmail.
- [ ] Fazer dump do PostgreSQL e conferir que o arquivo não está vazio:

  ```bash
  pg_dump --format=custom --file="/var/backups/avila-mail/pre-agenda-$(date -u +%Y%m%dT%H%M%SZ).dump" "$MAIL_DATABASE_URL"
  find /var/backups/avila-mail -name 'pre-agenda-*.dump' -size +0c -print -quit | grep -q .
  ```

## Deploy interno

- [x] Aplicar `npx prisma migrate deploy` antes de reiniciar a API.
- [x] Subir API e webmail construídos pelo mesmo workflow.
- [x] Confirmar API, MTA, webmail e Caddy ativos.
- [x] Conferir que `/api/v1/*` chega à API, `/api/mail/*` ao BFF e `/dav/*` à API.
- [x] Executar `npm run test:smoke:production` no artefato da API em produção.
- [x] Abrir `/agenda` em `noreply@avilaops.com` e confirmar criação, edição, exclusão, lembrete e sincronização CalDAV.
- [x] Conferir os logs sem erro novo:

  ```bash
  systemctl is-active avila-mail-api avila-mail-mta avila-webmail caddy
  journalctl -u avila-mail-api -u avila-webmail --since "15 minutes ago" --priority=err
  curl -fsS http://127.0.0.1:3040/v1/health
  ```

## Liberação geral

- [ ] Manter uso interno sem erro por uma semana.
- [x] Registrar a caixa e a janela de observação: `noreply@avilaops.com`, de 18/10/2026 12:36 a 25/10/2026 12:36 (`America/Sao_Paulo`).
- [ ] Alterar `AGENDA_ENABLED=all`, reiniciar o webmail e conferir `/agenda` numa caixa de cliente.
- [ ] Após aprovação de Nicolas, enviar o aviso às caixas ativas.

## Evidências

- Commit implantado: `fdf410f`.
- Pipeline de produção: `39142569398`, cinco jobs aprovados.
- Testes: integração 701/701, smoke de produção 251/251 e interface da agenda 87/87.
- Telas: `docs/screenshots/agenda-semana-desktop.png`, `agenda-editor-evento.png` e `agenda-lista-mobile.png`.
- Monitor diário: workflow n8n `RBFdbR360oKwKcPO`, às 08:00, com histórico saudável preservado.
- Primeira execução de produção: `98298`, com três eventos ativos, um excluído, dois lembretes enviados e zero erros.
- Backup disponível: `/var/backups/avila-mail/post-agenda-20261017T191550Z.dump`. É pós-deploy e não substitui a evidência de dump pré-deploy acima.

## Reversão

- [ ] Voltar imediatamente `AGENDA_ENABLED=false` se a interface apresentar falha.
- [ ] Preservar os dados de agenda; não reverter migrações destrutivamente.
- [ ] Restaurar o dump apenas em incidente de dados confirmado e com janela de manutenção aprovada.
