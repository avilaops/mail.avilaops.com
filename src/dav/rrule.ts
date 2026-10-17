import * as rruleNamespace from "rrule";

type RruleApi = typeof import("rrule");

const candidato = rruleNamespace as unknown as RruleApi & { default?: RruleApi };
const api = typeof candidato.RRule === "function" ? candidato : candidato.default;

if (!api) throw new Error("Pacote rrule sem API compativel.");

export const { RRule, rrulestr } = api;
