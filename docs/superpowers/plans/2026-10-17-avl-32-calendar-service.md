# AVL-32 — Serviço JSON sobre CalDAV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor operações de calendário em JSON usando o item CalDAV como fonte única.

**Architecture:** Criar `src/services/calendar.ts` como tradução entre o modelo JSON e `VEVENT`. Leituras usam os índices de `MailDavItem` e interpretam o blob; mutações passam exclusivamente por `gravarItem` e `excluirItem`, preservando etag, sequência e sincronização CalDAV. Eventos recorrentes são expandidos por `expandirRecorrencias`.

**Tech Stack:** TypeScript, Prisma, Zod, iCalendar/CalDAV existentes, smoke e integração.

**Spec:** Linear [AVL-32](https://linear.app/avilaops/issue/AVL-32/agenda-servico-calendarts-sobre-o-armazenamento-do-caldav).

## Global Constraints

- Não criar tabela paralela.
- Toda mutação deve incrementar a sequência DAV pelo store existente.
- Identidade externa usa o UID; o href criado pela API é `<uid>.ics`.
- Etag é obrigatório para atualização e exclusão; conflito responde como erro 412.
- Título tem no máximo 500 caracteres; fim não pode anteceder início; fuso deve ser IANA válido.
- Sem commit ou push até o módulo completo, testes e prints.

## Review Focus

- Isolamento por `mailboxId` em todas as consultas.
- Eventos importados podem ter href diferente do UID e extensões X-* desconhecidas.
- Alteração deve incrementar `SEQUENCE` e preservar UID, CREATED e extensões.
- Busca não pode depender apenas de `display_name`: local e descrição vivem no blob.
- Janela é `[de, ate)` e não pode perder evento que começa antes e termina dentro.

---

### Task 1: Modelo, validação e leitura

**Files:**

- Create: `src/services/calendar.ts`
- Test: `src/scripts/smoke.ts`
- Test: `src/scripts/integration.ts`

- [ ] Escrever testes RED da validação Zod para título, intervalo e fuso.
- [ ] Definir os modelos JSON de entrada, evento persistido e ocorrência.
- [ ] Implementar `obterEvento` e `listarJanela`, com expansão de recorrentes.
- [ ] Testar isolamento por caixa, limites exclusivos e evento sobreposto.

### Task 2: Criação, atualização e exclusão

**Files:**

- Modify: `src/services/calendar.ts`
- Modify: `src/dav/store.ts`
- Test: `src/scripts/integration.ts`

- [ ] Testes RED para criar evento e observar href/UID/etag/seq.
- [ ] Implementar `criarEvento` com UID seguro e timestamps do servidor.
- [ ] Testes RED para atualização, preservação de metadados e etag antigo 412.
- [ ] Implementar `atualizarEvento` sobre o blob original.
- [ ] Estender a exclusão do store com precondição etag e implementar `excluirEvento`.

### Task 3: Busca e verificação

**Files:**

- Modify: `src/services/calendar.ts`
- Test: `src/scripts/integration.ts`

- [ ] Testes RED para busca por título, local e descrição, sem vazamento entre caixas.
- [ ] Implementar busca limitada e ordenada.
- [ ] Rodar `npm run typecheck && npm test`.
- [ ] Solicitar revisão independente e corrigir achados Critical/Important.
