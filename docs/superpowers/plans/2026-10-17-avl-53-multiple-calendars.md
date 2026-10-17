# AVL-53 — Várias agendas por caixa

## Objetivo

Permitir múltiplas agendas independentes por caixa, preservando `/agenda/` como a coleção padrão e os `hrefs` existentes.

## Implementação

1. Criar `MailCalendar`, relacionar eventos por `calendarId` e migrar eventos atuais para `Agenda`.
2. Isolar sequência, sync-token, itens e lápides por agenda no store DAV.
3. Expor todas as coleções no CalDAV e suportar `MKCALENDAR`, `PROPPATCH` e `DELETE`.
4. Criar CRUD JSON em `/v1/me/calendar/calendars` e incluir `agendaId`/cor nos eventos.
5. Implementar lista, visibilidade, criação, edição, exclusão e seletor de agenda no webmail.
6. Cobrir migração, isolamento, DAV, API e interface com testes; executar suíte, lint e typecheck.
7. Capturar prints das telas somente após a validação funcional.

## Restrições

- Nenhum commit ou push antes do módulo inteiro, prints e testes aprovados.
- A agenda padrão mantém compatibilidade em `/dav/calendars/<caixa>/agenda/`.
- Não permitir a exclusão da última agenda da caixa.
