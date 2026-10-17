import assert from "node:assert/strict";
import { instanteParaCivil, civilParaInstante, intervaloCivilNoFuso, partesNoFuso } from "../lib/fusoAgenda";

assert.equal(instanteParaCivil(new Date("2026-10-17T12:30:00Z"), "America/Sao_Paulo"), "2026-10-17T09:30");
assert.equal(civilParaInstante("2026-10-17T09:30", "America/Sao_Paulo").toISOString(), "2026-10-17T12:30:00.000Z");
assert.deepEqual(partesNoFuso(new Date("2026-10-18T01:00:00Z"), "America/Sao_Paulo"), { ano: 2026, mes: 10, dia: 17, hora: 22, minuto: 0 });
assert.throws(() => civilParaInstante("2026-10-17T09:30", "Planeta/Marte"));
assert.throws(() => civilParaInstante("2026-03-08T02:30", "America/New_York"));
assert.deepEqual(Object.values(intervaloCivilNoFuso("2026-10-17", "2026-10-18", "America/Sao_Paulo")).map((data) => data.toISOString()), ["2026-10-17T03:00:00.000Z", "2026-10-18T03:00:00.000Z"]);

console.log("Agenda timezone conversion: 6 assertions passed");
