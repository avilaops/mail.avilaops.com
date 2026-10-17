import assert from "node:assert/strict";
import { dataCivil, diasDaGradeMes, diasDoMiniCalendario, diferencaDiasCivis, inicioDaSemana, intervaloDaVisao, lerDataCivil, lerVisaoAgenda, navegarData, rotuloDoIntervalo } from "@/lib/dataAgenda";

const referencia = new Date(2026, 9, 17, 12);
assert.equal(dataCivil(referencia), "2026-10-17");
assert.equal(dataCivil(lerDataCivil("2026-10-17")), "2026-10-17");
assert.equal(dataCivil(lerDataCivil("2026-02-31", referencia)), "2026-10-17");
assert.equal(lerVisaoAgenda("mes"), "mes");
assert.equal(lerVisaoAgenda("invalida"), "semana");
assert.equal(dataCivil(inicioDaSemana(referencia)), "2026-10-11");
assert.equal(dataCivil(inicioDaSemana(referencia, 1)), "2026-10-12");
assert.deepEqual(
  [dataCivil(intervaloDaVisao(referencia, "semana").inicio), dataCivil(intervaloDaVisao(referencia, "semana").fim)],
  ["2026-10-11", "2026-10-18"],
);
assert.equal(dataCivil(navegarData(referencia, "semana", 1)), "2026-10-24");
assert.equal(diasDoMiniCalendario(referencia).length, 42);
assert.equal(dataCivil(diasDoMiniCalendario(referencia)[0]!), "2026-09-27");
assert.match(rotuloDoIntervalo(referencia, "semana"), /^11 – 17 de out\. de 2026$/);
assert.equal(dataCivil(navegarData(new Date(2026, 0, 31), "mes", 1)), "2026-02-01");
assert.equal(dataCivil(navegarData(new Date(2026, 11, 31), "mes", 1)), "2027-01-01");
assert.equal(dataCivil(navegarData(new Date(2026, 0, 31), "lista", 1)), "2026-03-02");
assert.equal(diasDaGradeMes(referencia).length, 35);
assert.equal(diasDaGradeMes(new Date(2026, 7, 1)).length, 42);
const fusoOriginal = process.env.TZ;
process.env.TZ = "America/New_York";
assert.equal(diferencaDiasCivis(new Date(2026, 2, 8), new Date(2026, 2, 9)), 1);
process.env.TZ = fusoOriginal;

console.log("Agenda date navigation: 18 assertions passed");
