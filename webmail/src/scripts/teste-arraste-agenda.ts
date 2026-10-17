import assert from "node:assert/strict";
import { moverIntervalo, moverParaDia, redimensionarFim } from "../lib/arrasteAgenda";

const inicio = new Date(2026, 9, 17, 14, 0);
const fim = new Date(2026, 9, 17, 15, 0);
assert.equal(moverIntervalo(inicio, fim, 1, 15).inicio.getHours(), 14);
assert.equal(moverIntervalo(inicio, fim, 1, 15).inicio.getMinutes(), 15);
assert.equal(moverIntervalo(inicio, fim, 1, 15).fim.getDate(), 18);
assert.equal(redimensionarFim(inicio, fim, -120).getTime(), inicio.getTime() + 15 * 60_000);
const movido = moverParaDia(inicio, fim, new Date(2026, 9, 20));
assert.equal(movido.inicio.getDate(), 20);
assert.equal(movido.inicio.getHours(), 14);
assert.equal(movido.fim.getHours(), 15);
console.log("PASSOU — 7 verificações de arraste da agenda");
