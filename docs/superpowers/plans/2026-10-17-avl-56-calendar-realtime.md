# AVL-56 — Agenda em tempo real

## Objetivo

Propagar mudanças CalDAV pelo SSE existente e atualizar somente a janela visível sem desmontar o editor.

## Verificação

- Testar avanço de `dav_calendar_seq` no stream.
- Confirmar recarga sem piscar e conflito no editor.
- Executar integração, typecheck, lint e build.
