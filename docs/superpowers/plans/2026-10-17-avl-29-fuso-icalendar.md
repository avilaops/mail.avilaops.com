# AVL-29 — Fuso horário no iCalendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interpretar datas UTC, IANA, Outlook/Windows, flutuantes e de dia inteiro como instantes corretos no índice CalDAV.

**Architecture:** Manter `src/dav/ical.ts` como leitor mínimo e sem nova dependência. A leitura recebe o `TZID` da propriedade e o fuso padrão da caixa, resolve aliases conhecidos do Outlook para IANA e converte hora civil em instante UTC com `Intl.DateTimeFormat`; `lerEvento` repassa parâmetros e contexto às datas de início e fim sem reescrever o iCalendar original.

**Tech Stack:** Node.js 22+, TypeScript estrito, `Intl.DateTimeFormat`, smoke tests existentes em `src/scripts/smoke.ts`.

**Spec:** Linear [AVL-29](https://linear.app/avilaops/issue/AVL-29/agenda-interpretar-fuso-horario-tzid-e-vtimezone-no-icalendar) e documento [Agenda do Ávila Mail — funções e telas](https://linear.app/avilaops/document/a7115d86-719a-41d8-8eef-44e80ea0c48f).

## Global Constraints

- Não adicionar biblioteca de datas: usar `Intl` para fusos IANA.
- Datas flutuantes usam o fuso da caixa; o padrão é `America/Sao_Paulo`.
- O blob iCalendar recebido continua armazenado byte a byte, sem normalização.
- `dt_start` e `dt_end` representam o instante real em UTC no índice `mail_dav_items`.
- Datas `VALUE=DATE` permanecem como dia inteiro e não sofrem deslocamento por fuso.
- Nomes Windows comuns do Outlook são aliases explícitos para zonas IANA.
- É proibido fazer commit ou push parcial; ambos só podem ocorrer após o módulo de agenda inteiro estar finalizado, com testes aprovados e prints das telas registrados.

## Review Focus

- Horários durante a transição de DST precisam usar o deslocamento vigente naquela data, não o deslocamento atual.
- Uma hora civil inexistente ou ambígua durante DST precisa produzir resultado determinístico e documentado pelo teste.
- Um `TZID` desconhecido ou inválido não pode derrubar a ingestão do item CalDAV.
- `DTSTART` e `DTEND` podem declarar fusos diferentes e devem ser interpretados independentemente.
- O cálculo de `DURATION` deve continuar partindo do instante já convertido de `DTSTART`.

---

### Task 1: Conversão de hora civil para instante UTC

**Files:**

- Modify: `src/dav/ical.ts`
- Test: `src/scripts/smoke.ts`

**Interfaces:**

- Consumes: valores iCalendar `YYYYMMDD`, `YYYYMMDDTHHMMSS` e `YYYYMMDDTHHMMSSZ`; `TZID` opcional; fuso padrão opcional.
- Produces: `lerDataIcal(valor: string, opcoes?: { tzid?: string; fusoPadrao?: string }): { data: Date; diaInteiro: boolean } | null` e resolução interna de aliases Outlook/Windows.

- [ ] **Step 1: Escrever smoke tests que falham para IANA, Outlook e data flutuante**

Adicionar verificações com estes resultados exatos:

```ts
lerDataIcal("20260819T120000Z")?.data.toISOString() === "2026-08-19T12:00:00.000Z"
lerDataIcal("20260819T120000", { tzid: "America/Sao_Paulo" })?.data.toISOString() === "2026-08-19T15:00:00.000Z"
lerDataIcal("20260819T120000", { tzid: "E. South America Standard Time" })?.data.toISOString() === "2026-08-19T15:00:00.000Z"
lerDataIcal("20260819T120000")?.data.toISOString() === "2026-08-19T15:00:00.000Z"
lerDataIcal("20260819T120000", { fusoPadrao: "America/Manaus" })?.data.toISOString() === "2026-08-19T16:00:00.000Z"
lerDataIcal("20260819", { tzid: "America/Sao_Paulo" })?.data.toISOString() === "2026-08-19T00:00:00.000Z"
```

- [ ] **Step 2: Rodar o teste para confirmar RED**

Run: `npm run test:smoke`

Expected: FAIL nas novas verificações porque `lerDataIcal` ainda ignora as opções de fuso e trata a hora civil como UTC.

- [ ] **Step 3: Implementar a assinatura e a conversão mínima em `src/dav/ical.ts`**

Usar `Intl.DateTimeFormat(..., { timeZone })` para comparar os componentes civis desejados com os componentes renderizados no fuso e ajustar o candidato UTC até chegar ao instante correspondente. Resolver pelo menos `E. South America Standard Time` para `America/Sao_Paulo`; manter o mapa em constante interna extensível e validar o fuso construindo o formatter. UTC com sufixo `Z` e `VALUE=DATE` preservam a semântica atual.

- [ ] **Step 4: Fixar comportamento nos limites de DST e em fuso inválido**

Adicionar testes para `America/New_York` no inverno e verão, para a hora inexistente `20260308T023000`, para a hora ambígua `20261101T013000` e para `TZID` inválido. O contrato será: escolher a primeira ocorrência da hora ambígua; devolver `null` para hora inexistente ou fuso inválido.

- [ ] **Step 5: Rodar o smoke test para confirmar GREEN**

Run: `npm run test:smoke`

Expected: PASS, incluindo todos os casos antigos.

- [ ] **Step 6: Rodar checagem de tipos**

Run: `npm run typecheck`

Expected: exit code 0, sem diagnósticos.

### Task 2: Propagar TZID e fuso da caixa ao índice do evento

**Files:**

- Modify: `src/dav/ical.ts`
- Test: `src/scripts/smoke.ts`

**Interfaces:**

- Consumes: `lerDataIcal` da Task 1 e parâmetros crus de `DTSTART`/`DTEND` obtidos por `abrirLinha`.
- Produces: `lerEvento(texto: string, opcoes?: { fusoPadrao?: string }): EventoLido | null`, com `dtStart` e `dtEnd` convertidos para instantes reais.

- [ ] **Step 1: Escrever smoke tests que falham para propriedades com TZID**

Adicionar um VEVENT com `DTSTART;TZID=America/Sao_Paulo:20260820T140000` e `DTEND;TZID=America/Sao_Paulo:20260820T150000`; verificar `dtStart` em `2026-08-20T17:00:00.000Z` e `dtEnd` em `2026-08-20T18:00:00.000Z`. Adicionar outro evento com `TZID=E. South America Standard Time` e um evento flutuante lido com `{ fusoPadrao: "America/Manaus" }`.

- [ ] **Step 2: Rodar o teste para confirmar RED**

Run: `npm run test:smoke`

Expected: FAIL porque `lerEvento` ainda descarta os parâmetros das propriedades.

- [ ] **Step 3: Extrair TZID dos parâmetros e repassar as opções**

Em `src/dav/ical.ts`, adicionar helper interno para ler parâmetros separados por `;`, sem perder maiúsculas/minúsculas do valor, e chamar `lerDataIcal` separadamente para `DTSTART` e `DTEND`. O fuso padrão deve ser repassado para datas flutuantes; `DURATION` continua somando milissegundos ao instante convertido.

- [ ] **Step 4: Cobrir fusos independentes e duração**

Adicionar teste com `DTSTART` e `DTEND` em `TZID` diferentes e teste com `DTSTART;TZID=America/Sao_Paulo` mais `DURATION:PT1H30M`; verificar os instantes finais exatos.

- [ ] **Step 5: Rodar o smoke test para confirmar GREEN**

Run: `npm run test:smoke`

Expected: PASS.

- [ ] **Step 6: Rodar a suíte exigida pela issue**

Run: `npm run test:integration`

Expected: PASS. Se a suíte exigir serviços externos indisponíveis, registrar o comando e a falha exata, sem substituir o resultado por uma suíte menor.

- [ ] **Step 7: Rodar checagem de tipos final**

Run: `npm run typecheck`

Expected: exit code 0, sem diagnósticos.

### Task 3: Verificação de compatibilidade do armazenamento CalDAV

**Files:**

- Inspect: `src/dav/store.ts`
- Test: `src/scripts/integration.ts`

**Interfaces:**

- Consumes: `lerEvento` da Task 2 e o fluxo existente de `gravarItem`.
- Produces: evidência de que `mail_dav_items.dtStart` e `dtEnd` recebem os instantes retornados pelo leitor sem tabela paralela ou reescrita do blob.

- [ ] **Step 1: Confirmar por teste de integração que o índice persiste o instante convertido**

No cenário DAV existente da suíte de integração, gravar um VEVENT com `TZID=America/Sao_Paulo`, consultar o item/indexação e verificar que a janela UTC corresponde ao instante real e que o corpo retornado pelo CalDAV é byte a byte igual ao enviado.

- [ ] **Step 2: Rodar a suíte para confirmar RED caso a cobertura não exista**

Run: `npm run test:integration`

Expected: a nova asserção falha antes de qualquer ajuste adicional necessário no armazenamento.

- [ ] **Step 3: Fazer o menor ajuste necessário no chamador, somente se o teste demonstrar necessidade**

Preservar `gravarItem` e o schema atuais se eles já persistirem corretamente `evento.dtStart`/`evento.dtEnd`; não criar código de produção sem uma falha que o exija.

- [ ] **Step 4: Rodar todas as verificações finais**

Run: `npm run test:smoke && npm run typecheck && npm run test:integration`

Expected: todos os comandos passam sem avisos novos.

- [ ] **Step 5: Registrar evidências sem commit**

Manter as alterações locais e registrar os resultados dos testes no controle de desenvolvimento. Não executar `git commit` nem `git push`; a liberação dessas operações pertence ao gate final do módulo completo, depois das telas implementadas e dos respectivos prints.

## Gate final do módulo de agenda

- Todas as fases e tarefas do módulo de agenda no Linear precisam estar finalizadas.
- Todos os testes de servidor, integração e webmail precisam estar aprovados.
- As telas precisam ser verificadas no navegador nos layouts desktop e celular.
- Os prints das telas precisam estar produzidos e registrados como evidência.
- Somente depois dessas quatro condições é permitido criar o primeiro commit do módulo e executar o push.
