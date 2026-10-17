# AVL-45 — Edição de recorrência e escopos

**Goal:** permitir criar regras recorrentes e editar, mover ou excluir esta ocorrência, esta e as seguintes, ou toda a série, preservando interoperabilidade CalDAV.

## Plano

1. Cobrir por testes as transformações iCalendar de EXDATE, exceção com RECURRENCE-ID e divisão da série.
2. Implementar `scope` e `recurrenceId` em PATCH/DELETE, com CAS pelo ETag.
3. Para `this`, gravar EXDATE ou VEVENT de exceção no mesmo recurso.
4. Para `following`, limitar a série original com UNTIL e criar nova série com UID novo; redistribuir exceções pertinentes.
5. Para `all`, manter atualização/exclusão do recurso completo e ajustar exceções quando o horário-base mudar.
6. Adicionar diálogo de escopo aos fluxos de edição, arraste e exclusão.
7. Verificar integração JSON↔CalDAV, typecheck, lint e build.
