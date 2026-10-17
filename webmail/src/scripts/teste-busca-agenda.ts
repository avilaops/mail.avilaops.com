import assert from "node:assert/strict";
import { intervaloDestaque } from "../lib/buscaAgenda";

function trecho(texto: string, termo: string): string {
  const intervalo = intervaloDestaque(texto, termo);
  return intervalo ? texto.slice(intervalo.inicio, intervalo.fim) : "";
}

assert.equal(trecho("Reunião estratégica", "estrategica"), "estratégica");
assert.equal(trecho("Café e Reunião", "reunião"), "Reunião");
assert.equal(trecho("Cafe\u0301 amanhã", "café"), "Cafe\u0301");
assert.equal(intervaloDestaque("Planejamento", "ausente"), null);
console.log("PASSOU — 4 verificações do destaque da busca");
