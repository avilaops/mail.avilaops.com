import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import { chromium } from "playwright";

// Componente real em Chromium; API inteiramente local e controlada. Nenhuma
// mensagem, credencial, comprovante ou caixa de producao participa do teste.
const bundle = await build({
  stdin: { contents: `import { createElement, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { Compositor } from "./src/components/Compositor";
    function Fixture() {
      const [aberto, abrir] = useState(true);
      return createElement("main", null,
        createElement("button", { id: "fora", onClick: () => abrir(true) }, "Abrir compositor"),
        aberto && createElement(Compositor, {
          contexto: { tipo: "novo", para: ["teste@exemplo.test"], corpo: "Mensagem preservada" },
          onFechar: () => abrir(false), onEnviado: () => {} }));
    }
    createRoot(document.getElementById("root")).render(createElement(Fixture));`,
    resolveDir: process.cwd(), loader: "tsx" },
  tsconfig: "tsconfig.json", bundle: true, write: false, format: "iife", logLevel: "silent",
});
const uploads = [];
let falhar = false;
const backend = createServer(async (req, res) => {
  if (req.url === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    return res.end(bundle.outputFiles[0].text);
  }
  if (req.url === "/") return res.end('<!doctype html><meta charset="UTF-8"><div id="root"></div><script src="/bundle.js"></script>');
  let dados = "";
  for await (const parte of req) dados += parte;
  const input = dados ? JSON.parse(dados) : {};
  let resultado = {};
  let status = 200;
  if (req.url === "/api/mail/me/send-as") resultado = { addresses: [{ address: "teste@exemplo.test", primary: true }] };
  if (req.url === "/api/mail/me/contacts") resultado = { contacts: [] };
  if (req.url === "/api/mail/me/drafts") resultado = { draftId: "rascunho-local", attachments: [] };
  if (req.url === "/api/mail/me/messages/send") throw new Error("Este teste nao envia mensagens");
  if (req.url === "/api/mail/me/attachments" && req.method === "POST") {
    uploads.push(input);
    status = falhar ? 413 : 201;
    resultado = falhar ? { erro: "Arquivo excede o limite de teste." }
      : { id: `anexo-${uploads.length}`, filename: input.filename, contentType: input.contentType,
        sizeBytes: Buffer.from(input.contentBase64, "base64").length };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(resultado));
});
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const base = `http://127.0.0.1:${backend.address().port}`;
let browser;

async function soltar(alvo, nomes, tipo = "Files") {
  return alvo.evaluate((elemento, { nomes, tipo }) => {
    const dataTransfer = new DataTransfer();
    if (tipo === "Files") for (const name of nomes) dataTransfer.items.add(new File(["%PDF-arquivo-sintetico"], name, { type: "application/pdf" }));
    else dataTransfer.setData("text/plain", "texto movido dentro do editor");
    const cancelados = [];
    for (const type of ["dragenter", "dragover", "drop"]) {
      const evento = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
      elemento.dispatchEvent(evento);
      cancelados.push(evento.defaultPrevented);
    }
    return cancelados;
  }, { nomes, tipo });
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(base);
    const dialog = page.getByRole("dialog", { name: "Nova mensagem" });
    const editor = dialog.getByRole("textbox", { name: "Corpo da mensagem" });
    await editor.waitFor();
    const antes = uploads.length;
    const cancelados = await soltar(editor, ["comprovante.pdf", "segunda-parcela.pdf"]);
    assert.deepEqual(cancelados, [true, true, true], "queda de arquivo precisa impedir navegacao e insercao no editor");
    await dialog.getByRole("button", { name: "Remover segunda-parcela.pdf" }).waitFor();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Remover comprovante.pdf"]')?.disabled);
    assert.equal(uploads.length, antes + 2, "um upload por arquivo");
    assert.deepEqual(uploads.slice(antes).map(item => item.filename).sort(), ["comprovante.pdf", "segunda-parcela.pdf"]);
    assert.equal(Buffer.from(uploads[antes].contentBase64, "base64").toString(), "%PDF-arquivo-sintetico");
    assert.equal(await editor.innerText(), "Mensagem preservada", "arquivo nao vira link ou imagem no corpo");
    assert.equal(page.url(), base + "/");

    const fora = page.locator("#fora");
    assert.equal((await soltar(fora, ["fora.pdf"]))[2], true, "soltar fora preserva pagina e rascunho");
    assert.equal(uploads.length, antes + 2, "queda fora nao anexa silenciosamente");
    assert.deepEqual(await soltar(editor, [], "text/plain"), [false, false, false], "arraste de texto continua nativo");
    await dialog.getByRole("button", { name: "Remover comprovante.pdf" }).click();
    assert.equal(await dialog.getByRole("button", { name: "Remover comprovante.pdf" }).count(), 0);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: "pelo-seletor.pdf", mimeType: "application/pdf", buffer: Buffer.from("seletor preservado"),
    });
    await dialog.getByRole("button", { name: "Remover pelo-seletor.pdf" }).waitFor();
    assert.equal(uploads.at(-1).filename, "pelo-seletor.pdf", "seletor continua usando o mesmo fluxo");
    await editor.evaluate(elemento => {
      // Dragover real nao expoe FileList (modo protegido); o tipo Files basta.
      const dataTransfer = new DataTransfer();
      Object.defineProperty(dataTransfer, "types", { value: ["Files"] });
      elemento.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
    });
    await dialog.getByRole("status").filter({ hasText: "Solte os arquivos aqui" }).waitFor();
    await editor.evaluate(elemento => {
      const dataTransfer = new DataTransfer();
      Object.defineProperty(dataTransfer, "types", { value: ["Files"] });
      elemento.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer }));
    });
    assert.equal(await dialog.getByRole("status").filter({ hasText: "Solte os arquivos aqui" }).count(), 0);

    falhar = true;
    await soltar(dialog, ["grande.pdf"]);
    await dialog.getByText("Arquivo excede o limite de teste.").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Enviar", exact: true }).first().isDisabled(), true);
    falhar = false;

    await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
    assert.equal((await soltar(fora, ["apos-fechar.pdf"]))[2], false, "listeners removidos ao fechar compositor");
    await page.close();
    console.log(`PASS arraste/anexos ${width}px: multiplos PDFs, bytes, editor, queda fora, texto, remocao, seletor, indicador, falha e cleanup`);
  }
} finally {
  await browser?.close();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
}
