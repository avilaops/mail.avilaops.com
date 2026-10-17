# AVL-36 — Barra lateral da agenda

**Goal:** Dar navegacao temporal e entre visoes por URL, com mini calendario responsivo e entrada de criacao.

## Tasks

- [x] Modelar data e visao na query string, com valores invalidos normalizados.
- [x] Criar mini calendario com periodo visivel, Hoje, anterior e proximo.
- [x] Criar seletor Dia, Semana, Mes e Lista.
- [x] Transformar a lateral em gaveta no celular.
- [x] Abrir o editor pelo botao Criar.
- [ ] Validar lint, typecheck, build, testes e revisao independente.

## Constraints

- Datas civis usam `YYYY-MM-DD`; navegacao nao sofre deslocamento UTC.
- URL e a fonte do estado compartilhavel.
- Sem commit ou push antes do modulo inteiro, testes e prints.
