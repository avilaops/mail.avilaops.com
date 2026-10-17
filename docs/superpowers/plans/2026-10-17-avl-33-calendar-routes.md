# AVL-33 — Rotas JSON da Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor o serviço de calendário em `/v1/me/calendar` para o webmail, mantendo chaves de API sem acesso nesta etapa.

**Architecture:** Registrar as seis rotas em `src/api/me-routes.ts`, reutilizando o serviço AVL-32 e o tratamento de erros existente em `src/api/index.ts`. Datas e corpos são validados antes do serviço; a listagem limita janelas a 100 dias. `If-Match` é obrigatório nas mutações concorrentes.

**Tech Stack:** TypeScript, HTTP nativo, Zod, integração com Postgres.

**Spec:** Linear [AVL-33](https://linear.app/avilaops/issue/AVL-33/agenda-rotas-json-v1mecalendar-na-api).

## Global Constraints

- Bloquear todo `/v1/me/calendar` quando a autenticação vier de `amk_m_`.
- Janela GET obrigatória, válida, semiaberta e com no máximo 100 dias.
- PATCH e DELETE exigem `If-Match`; etag é devolvido também no corpo.
- Usar o envelope/erro JSON já consumido pelo webmail.
- Documentar as rotas no README.
- Sem commit ou push até o módulo completo, testes e prints.

---

### Task 1: Contrato HTTP e autorização

**Files:**

- Modify: `src/api/me-routes.ts`
- Modify: `src/api/index.ts`
- Test: `src/scripts/integration.ts`

- [ ] Testes RED para autenticação, bloqueio de chave API e janela ausente/inválida/>100 dias.
- [ ] Importar o serviço e registrar `CalendarError` no tratamento de erros.
- [ ] Implementar GET de janela, detalhe e busca.

### Task 2: Mutações e concorrência

**Files:**

- Modify: `src/api/me-routes.ts`
- Test: `src/scripts/integration.ts`

- [ ] Testes RED para POST, PATCH e DELETE.
- [ ] Exigir e normalizar `If-Match` em PATCH/DELETE.
- [ ] Verificar 412 com etag antigo e isolamento entre caixas.

### Task 3: Documentação e gate

**Files:**

- Modify: `README.md`

- [ ] Atualizar a tabela “O que já existe”.
- [ ] Rodar `npm run typecheck && npm test`.
- [ ] Solicitar revisão independente e corrigir Critical/Important.
