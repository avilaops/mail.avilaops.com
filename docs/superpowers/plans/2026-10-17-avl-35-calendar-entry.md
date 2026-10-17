# AVL-35 — Entrada da agenda no webmail

**Goal:** Criar `/agenda` sob a sessão existente e navegação Mail ⇄ Agenda sem perder contexto.

## Tasks

- [x] Criar navegação de produto responsiva e rota protegida `/agenda`.
- [x] Persistir a pasta aberta durante a ida à agenda.
- [x] Adicionar sequências `g a` e `g i` aos atalhos.
- [x] Definir os tipos e o cliente completo da API de eventos, incluindo `If-Match` pelo BFF.
- [ ] Validar typecheck, lint, build, navegação no navegador e screenshot.
- [x] Cobrir renderização segura do conteúdo hostil exigida pelo AVL-34.

## Design

- Paleta e tipografia permanecem nos tokens existentes.
- Uma barra persistente representa Mail e Agenda como instrumentos do mesmo produto.
- A identidade da agenda fica numa única linha temporal azul; superfícies ao redor permanecem quietas.
