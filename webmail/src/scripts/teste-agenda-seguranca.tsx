import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { EventoNaAgenda } from "@/components/EventoNaAgenda";
import type { EventoAgenda } from "@/lib/tipos";

const hostil = `<script>alert("agenda")</script>\r\n<img src=x onerror=alert(1)>`;
const evento: EventoAgenda = {
  id: "hostil.ics",
  href: "/dav/calendars/caixa/calendar/hostil.ics",
  uid: "hostil@teste",
  etag: '"etag-hostil"',
  titulo: hostil,
  inicio: "2026-10-17T13:00:00.000Z",
  fim: "2026-10-17T14:00:00.000Z",
  diaInteiro: false,
  fuso: "America/Sao_Paulo",
  local: hostil,
  descricao: `Descricao ${hostil}`,
  lembretes: [],
  convidados: [],
  disponibilidade: "ocupado",
  sequencia: 0,
  criadoEm: "2026-10-17T12:00:00.000Z",
  modificadoEm: "2026-10-17T12:00:00.000Z",
  dtstamp: "2026-10-17T12:00:00.000Z",
};

const html = renderToStaticMarkup(<EventoNaAgenda evento={evento} />);

assert.equal(html.includes("<script"), false, "o titulo nao pode criar um elemento script");
assert.equal(html.includes("<img"), false, "o local nao pode criar um elemento img");
assert.equal(html.includes("onerror="), true, "o texto hostil deve continuar visivel como texto");
assert.equal(html.includes("&lt;script&gt;"), true, "o React deve escapar as tags do titulo");
assert.equal(html.includes("&lt;img"), true, "o React deve escapar as tags do local");
assert.equal(html.includes("Descricao &lt;script&gt;"), true, "o React deve escapar as tags da descricao");

console.log("Agenda UI security: 6 assertions passed");
