import assert from "node:assert/strict";
import { intervaloDiaInteiro, intervaloValido, moverFimMantendoDuracao, proximoDiaCivil, tituloDoEvento } from "../lib/editorAgenda";

let verificacoes = 0;
function igual<T>(atual: T, esperado: T) { assert.equal(atual, esperado); verificacoes += 1; }

igual(tituloDoEvento("  Reunião  "), "Reunião");
igual(tituloDoEvento("   "), "(sem título)");
igual(intervaloValido("2026-10-17T10:00", "2026-10-17T11:00"), true);
igual(intervaloValido("2026-10-17T11:00", "2026-10-17T10:00"), false);
igual(moverFimMantendoDuracao("2026-10-17T10:00", "2026-10-17T11:30", "2026-10-17T12:00").slice(11), "13:30");
igual(proximoDiaCivil("2026-12-31"), "2027-01-01");
igual(intervaloDiaInteiro("2026-10-17", "2026-10-17").fim, "2026-10-18T00:00:00.000Z");
igual(intervaloDiaInteiro("2026-10-17", "2026-10-20").fim, "2026-10-20T00:00:00.000Z");
process.env.TZ = "Asia/Tokyo";
igual(intervaloDiaInteiro("2026-10-17", "2026-10-18").inicio, "2026-10-17T00:00:00.000Z");

console.log(`PASSOU — ${verificacoes} verificações do editor da agenda`);
