# AVL-31 — Expansão de recorrência Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expandir RRULE, RDATE, EXDATE e exceções RECURRENCE-ID em uma janela segura para as telas da agenda.

**Architecture:** Criar `src/dav/recorrencia.ts` sobre `rrule@2.8.1`, biblioteca madura escolhida conforme recomendação da issue. O módulo extrai o VEVENT mestre e exceções do mesmo VCALENDAR, delega a gramática/expansão ao `rrule`, converte cada ocorrência em instante real, aplica substituições por RECURRENCE-ID e interrompe no limite configurado.

**Tech Stack:** TypeScript, `rrule@2.8.1`, parser iCalendar existente, smoke tests.

**Spec:** Linear [AVL-31](https://linear.app/avilaops/issue/AVL-31/agenda-expandir-recorrencia-rrule-rdate-exdate-recurrence-id-numa).

## Global Constraints

- Expandir no fuso do DTSTART, preservando a hora civil durante DST.
- Janela é `[inicio, fim)`, com fim exclusivo.
- Limite padrão de 1.000 ocorrências; exceder lança erro explícito.
- Exceção movida substitui o RECURRENCE-ID original, inclusive quando sai da janela original.
- Sem commit ou push até o módulo completo, testes e prints.

## Review Focus

- RRULE infinita em janela enorme precisa parar no teto, sem consumir memória ilimitada.
- Evento que começa antes da janela mas termina dentro dela precisa aparecer.
- EXDATE e RECURRENCE-ID devem comparar instantes, não strings com representações diferentes.
- DST deve manter 09:00 local mesmo quando o deslocamento UTC muda.
- Exceção cancelada ou duplicada não pode produzir duas ocorrências.

---

### Task 1: Regras básicas e limite

**Files:**

- Create: `src/dav/recorrencia.ts`
- Test: `src/scripts/smoke.ts`

**Interfaces:**

- Produces: `expandirRecorrencias(ical: string, janela: { inicio: Date; fim: Date; limite?: number; fusoPadrao?: string }): OcorrenciaEvento[]`.

- [ ] Testes RED para diária, semanal BYDAY, mensal BYSETPOS, anual, COUNT e UNTIL.
- [ ] Teste RED para regra infinita excedendo limite.
- [ ] Implementar expansão mínima com `rrule` e duração do mestre.
- [ ] Rodar smoke e typecheck.

### Task 2: RDATE, EXDATE e exceções

**Files:**

- Modify: `src/dav/recorrencia.ts`
- Test: `src/scripts/smoke.ts`

- [ ] Testes RED para RDATE adicional, EXDATE removida e VEVENT com RECURRENCE-ID movido.
- [ ] Implementar conjunto, exclusões e substituições por instante.
- [ ] Cobrir exceção que entra/sai da janela e deduplicação.
- [ ] Rodar smoke e typecheck.

### Task 3: Fusos e integração

**Files:**

- Modify: `src/dav/recorrencia.ts`
- Test: `src/scripts/smoke.ts`
- Test: `src/scripts/integration.ts`

- [ ] Teste RED semanal atravessando DST em America/New_York e mantendo hora local.
- [ ] Teste RED para evento iniciado antes da janela e ainda em andamento.
- [ ] Adicionar prova de integração com item CalDAV real.
- [ ] Rodar `npm run typecheck && npm test`; registrar sem commit.
