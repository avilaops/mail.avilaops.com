# AVL-34 — Ida e volta API JSON e CalDAV

**Goal:** Provar contra PostgreSQL real que API JSON e CalDAV operam a mesma fonte de eventos.

## Tasks

- [x] Criar pela API e verificar por `calendar-query` e `sync-collection`, preservando UID.
- [x] Criar, editar e excluir pelo `tsdav`; verificar cada mudança pela API.
- [x] Verificar conflito 412 quando CalDAV altera o ETag antes da API.
- [x] Reforçar recorrência com exceção e conteúdo hostil sem quebra estrutural e na tela.
- [x] Atualizar a contagem do README, rodar a suíte completa e obter revisão independente.

## Constraints

- Testes usam os clientes HTTP/CalDAV reais já levantados pela integração.
- Nenhuma tabela paralela ou atalho direto para validar comportamento público.
- Sem commit ou push antes do módulo inteiro, testes e prints.
