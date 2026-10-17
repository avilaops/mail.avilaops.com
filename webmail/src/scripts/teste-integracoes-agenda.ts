import assert from "node:assert/strict";
import { convidadosSugeridosDeMensagem } from "@/components/LeitorMensagem";
import { validarArquivoIcs } from "@/lib/transferenciaAgenda";
import type { MensagemCompleta } from "@/lib/tipos";

const mensagem = {
  fromAddress: "REMETENTE@EXEMPLO.COM",
  toAddresses: [{ address: "caixa@avilaops.com" }, { address: "colega@exemplo.com" }],
  ccAddresses: [{ address: "Colega@Exemplo.com" }, { address: "outra@exemplo.com" }],
} as MensagemCompleta;

assert.deepEqual(
  convidadosSugeridosDeMensagem(mensagem, "CAIXA@AVILAOPS.COM"),
  ["remetente@exemplo.com", "colega@exemplo.com", "outra@exemplo.com"],
  "sugestões devem remover a própria caixa, normalizar e deduplicar destinatários",
);

function arquivo(name: string, texto: string, size = new TextEncoder().encode(texto).byteLength) {
  return { name, size, text: async () => texto };
}

async function main() {
  const evento = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Teste\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  assert.equal(await validarArquivoIcs(arquivo("agenda.ics", evento)), null);
  assert.match(await validarArquivoIcs(arquivo("agenda.txt", evento)) ?? "", /extensão \.ics/);
  assert.match(await validarArquivoIcs(arquivo("agenda.ics", evento, 50 * 1024 * 1024 + 1)) ?? "", /50 MB/);
  assert.match(await validarArquivoIcs(arquivo("agenda.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")) ?? "", /não contém eventos/);
  const muitos = `BEGIN:VCALENDAR\r\n${"BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n".repeat(10_001)}END:VCALENDAR\r\n`;
  assert.match(await validarArquivoIcs(arquivo("agenda.ics", muitos)) ?? "", /10 mil eventos/);
  const enorme = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:grande\r\nDESCRIPTION:${"x".repeat(512 * 1024)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  assert.match(await validarArquivoIcs(arquivo("agenda.ics", enorme)) ?? "", /512 KB/);
  console.log("Agenda message/import integrations: 7 assertions passed");
}

void main();
