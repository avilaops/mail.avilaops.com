import assert from "node:assert/strict";
import { eventoVaiParaFaixa, posicionarEventos } from "@/lib/layoutAgenda";
import type { EventoAgenda } from "@/lib/tipos";

function evento(id: string, inicio: string, fim: string, diaInteiro = false): EventoAgenda {
  return {
    id, href: `${id}.ics`, uid: id, etag: id, titulo: id, inicio, fim, diaInteiro,
    fuso: "America/Sao_Paulo", lembretes: [], convidados: [], disponibilidade: "ocupado",
    sequencia: 0, criadoEm: inicio, modificadoEm: inicio, dtstamp: inicio,
  };
}

const a = evento("a", "2026-10-19T09:00:00-03:00", "2026-10-19T11:00:00-03:00");
const b = evento("b", "2026-10-19T09:30:00-03:00", "2026-10-19T10:00:00-03:00");
const c = evento("c", "2026-10-19T10:00:00-03:00", "2026-10-19T12:00:00-03:00");
const d = evento("d", "2026-10-19T12:00:00-03:00", "2026-10-19T13:00:00-03:00");
const inteiro = evento("inteiro", "2026-10-19T00:00:00-03:00", "2026-10-20T00:00:00-03:00", true);

const resultado = posicionarEventos([d, b, inteiro, c, a]);
assert.equal(resultado.length, 4);
assert.equal(eventoVaiParaFaixa(inteiro), true);
assert.equal(resultado.find((item) => item.evento.id === "a")?.coluna, 0);
assert.equal(resultado.find((item) => item.evento.id === "b")?.coluna, 1);
assert.equal(resultado.find((item) => item.evento.id === "c")?.coluna, 1);
assert.equal(resultado.find((item) => item.evento.id === "a")?.totalColunas, 2);
assert.equal(resultado.find((item) => item.evento.id === "d")?.totalColunas, 1);
assert.equal(resultado.find((item) => item.evento.id === "a")?.duracaoMinutos, 120);

console.log("Agenda overlap layout: 8 assertions passed");
