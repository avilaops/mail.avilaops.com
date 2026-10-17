import assert from "node:assert/strict";
import { gerarRegraRecorrencia, lerConfiguracaoRecorrencia } from "../lib/recorrenciaAgenda";

const inicio = new Date(2026, 9, 20, 9);
assert.equal(gerarRegraRecorrencia({ frequencia: "semanal", intervalo: 1, diasSemana: ["TU", "TH"], termino: "nunca", dataTermino: "", quantidade: 10, personalizada: "" }, inicio), "FREQ=WEEKLY;BYDAY=TU,TH");
assert.equal(gerarRegraRecorrencia({ frequencia: "mensal-semana", intervalo: 1, diasSemana: [], termino: "quantidade", dataTermino: "", quantidade: 5, personalizada: "" }, inicio), "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=3;COUNT=5");
assert.equal(gerarRegraRecorrencia({ frequencia: "anual", intervalo: 1, diasSemana: [], termino: "data", dataTermino: "2027-12-31", quantidade: 1, personalizada: "" }, inicio), "FREQ=YEARLY;UNTIL=20271231T235959Z");
assert.equal(lerConfiguracaoRecorrencia("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8", inicio).diasSemana.join(","), "MO,WE");
console.log("PASSOU — 4 verificações do editor de recorrência");
