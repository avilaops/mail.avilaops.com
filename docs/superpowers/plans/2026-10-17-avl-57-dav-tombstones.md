# AVL-57 — Faxina de lapides DAV

**Goal:** Limitar o crescimento de `mail_dav_items` sem permitir que um cliente perca exclusoes.

## Tasks

- [x] Persistir o menor token valido por caixa e colecao.
- [x] Apagar lapides com mais de 90 dias na manutencao diaria.
- [x] Responder `403 DAV:valid-sync-token` para token anterior ao piso.
- [x] Cobrir contatos e agenda, inclusive novo sync inicial sem o item apagado.
- [x] Rodar a suite completa e obter revisao independente.

## Constraints

- O piso avanca apenas ate a maior sequencia realmente removida.
- Token igual ao piso continua valido; somente token menor e rejeitado.
- Sync inicial sem token continua aceito.
- Sem commit ou push antes do modulo inteiro, testes e prints.
