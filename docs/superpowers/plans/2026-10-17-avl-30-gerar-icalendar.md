# AVL-30 — Gerar iCalendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar VCALENDAR/VEVENT completo e interoperável a partir do modelo JSON da agenda, sem perder extensões de eventos importados.

**Architecture:** Manter parsing e serialização RFC 5545 em `src/dav/ical.ts`, com helpers puros para escape, data e dobra UTF-8. O gerador recebe UID e timestamps explícitos para ser determinístico, produz o mesmo blob consumido por `gravarItem` e aceita um iCalendar original opcional para preservar propriedades `X-*` do VEVENT.

**Tech Stack:** Node.js 22+, TypeScript estrito, `Intl`, smoke e integração existentes, sem biblioteca nova.

**Spec:** Linear [AVL-30](https://linear.app/avilaops/issue/AVL-30/agenda-gerar-icalendar-vevent-a-partir-do-modelo-json) e documento [Agenda do Ávila Mail — funções e telas](https://linear.app/avilaops/document/a7115d86-719a-41d8-8eef-44e80ea0c48f).

## Global Constraints

- Nenhuma linha física pode exceder 75 octetos antes de CRLF; continuação começa com espaço.
- Textos escapam barra, quebra de linha, vírgula e ponto e vírgula conforme RFC 5545.
- UID é fornecido pelo chamador e permanece estável; `SEQUENCE` é explícito.
- `DTEND` de dia inteiro é exclusivo.
- Datas com hora usam `TZID`; datas de dia inteiro usam `VALUE=DATE`.
- O gerador preserva propriedades `X-*` existentes que ele próprio não controla.
- É proibido fazer commit ou push até o módulo inteiro, testes e prints estarem concluídos.

## Review Focus

- UTF-8 multibyte exatamente no limite de dobra não pode ser cortado no meio.
- Valores com CRLF ou barras não podem injetar propriedades adicionais.
- Parâmetros de convidado com aspas, vírgulas ou ponto e vírgula precisam permanecer válidos.
- `SEQUENCE:0` e lembrete de zero minuto não podem desaparecer por teste truthy.
- Eventos vindos de outro cliente não podem duplicar propriedades `X-*` a cada edição.

---

### Task 1: Primitivas RFC 5545

**Files:**

- Modify: `src/dav/ical.ts`
- Test: `src/scripts/smoke.ts`

**Interfaces:**

- Produces: helpers internos de escape de texto, escape de parâmetro, formatação UTC/local/data e `dobrarLinhaIcal(linha: string): string[]`.

- [ ] Escrever testes RED para escape de `\\`, vírgula, ponto e vírgula e CRLF; dobra ASCII em 75 octetos; dobra UTF-8 sem corromper emoji/acentos.
- [ ] Implementar os helpers mínimos e rodar `npm run test:smoke` até GREEN.
- [ ] Rodar `npm run typecheck`.

### Task 2: Gerar e reler VEVENT completo

**Files:**

- Modify: `src/dav/ical.ts`
- Test: `src/scripts/smoke.ts`

**Interfaces:**

- Produces: `EventoIcal`, `ConvidadoIcal`, `LembreteIcal`, `gerarEventoIcal(evento: EventoIcal): string`; `lerEvento` passa a expor os campos necessários para provar ida e volta sem remover os campos de índice atuais.

- [ ] Escrever teste RED de evento com UID, DTSTAMP, CREATED, LAST-MODIFIED, SEQUENCE, DTSTART/DTEND, SUMMARY, LOCATION, DESCRIPTION, RRULE, ORGANIZER, ATTENDEE, VALARM e TRANSP.
- [ ] Escrever teste RED separado para evento de dia inteiro e para `SEQUENCE:0`/lembrete zero.
- [ ] Implementar a geração mínima, incluindo `VCALENDAR`, `VERSION:2.0`, `PRODID:-//Avila Ops//Avila Mail//PT-BR` e CRLF final.
- [ ] Estender a leitura apenas o necessário para confirmar a ida e volta com valores literais.
- [ ] Rodar `npm run test:smoke` e `npm run typecheck`.

### Task 3: Preservar extensões e interoperabilidade CalDAV

**Files:**

- Modify: `src/dav/ical.ts`
- Test: `src/scripts/smoke.ts`
- Test: `src/scripts/integration.ts`

**Interfaces:**

- Extends: `gerarEventoIcal(evento, { original?: string })`.

- [ ] Escrever teste RED com propriedades `X-APPLE-*` dobradas e repetição de edição; verificar preservação sem duplicação.
- [ ] Implementar coleta das propriedades `X-*` do VEVENT original, excluindo nomes produzidos pelo gerador, e redobrá-las na saída.
- [ ] Adicionar integração que grave o evento gerado por CalDAV, releia pelo `tsdav` e confira campos essenciais.
- [ ] Rodar `npm run typecheck && npm test`; registrar evidência sem commit.

## Gate final

- Nenhum commit ou push nesta issue.
- O commit único permanece bloqueado até todas as fases do módulo, testes web/servidor e prints desktop/celular estarem concluídos.
