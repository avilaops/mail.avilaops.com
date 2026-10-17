import assert from "node:assert/strict";
import { agruparEventosPorDia, rotuloDoDia } from "@/lib/listaAgenda";
import type { EventoAgenda } from "@/lib/tipos";

function evento(id: string, inicio: string): EventoAgenda {
  return { id, href: id, uid: id, etag: id, titulo: id, inicio, fim: new Date(new Date(inicio).getTime() + 3_600_000).toISOString(), diaInteiro: false, fuso: "UTC", lembretes: [], convidados: [], disponibilidade: "ocupado", sequencia: 0, criadoEm: inicio, modificadoEm: inicio, dtstamp: inicio };
}

const grupos = agruparEventosPorDia([
  evento("amanha", "2026-10-18T13:00:00-03:00"),
  evento("cedo", "2026-10-17T09:00:00-03:00"),
  evento("tarde", "2026-10-17T15:00:00-03:00"),
]);
assert.equal(grupos.length, 2);
assert.deepEqual(grupos[0]?.eventos.map((item) => item.id), ["cedo", "tarde"]);
assert.equal(rotuloDoDia(new Date(2026, 9, 17), new Date(2026, 9, 17)), "Hoje");
assert.equal(rotuloDoDia(new Date(2026, 9, 18), new Date(2026, 9, 17)), "Amanhã");
assert.match(rotuloDoDia(new Date(2026, 9, 19), new Date(2026, 9, 17)), /19 de out\./);

console.log("Agenda list grouping: 5 assertions passed");
