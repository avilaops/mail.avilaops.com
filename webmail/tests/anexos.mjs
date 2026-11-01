import assert from "node:assert/strict";

// Dados exclusivos do navegador de teste; nenhuma caixa ou entrega real.
const anexos = Array.from({ length: 18 }, (_, indice) => ({
  id: `arquivo-ci-${indice}`, filename: `Documento_${indice + 1}_${"nome_longo_".repeat(8)}.txt`,
  contentType: "text/plain", sizeBytes: 1024 + indice, contentId: null,
}));
const original = {
  id: "anexos-ci", folderId: "pasta-entrada-ci", threadKey: null,
  fromAddress: "origem@exemplo.test", fromName: "Remetente de teste", toAddresses: [], ccAddresses: [],
  subject: "Anexos CI", snippet: "Mensagem com dezoito documentos", seen: true, flagged: false,
  answered: false, hasAttachments: true, sizeBytes: 18000, spamScore: null, quarantineReason: null,
  senderVerified: false, receivedAt: "2026-11-01T12:00:00Z", bodyText: "O corpo precisa continuar legível com todos os anexos.",
  bodyHtml: null, blockedRemoteImages: 1, attachments: anexos, convite: null,
};
const mensagens = new Map([[original.id, original], ["sem-anexos-ci", { ...original, id: "sem-anexos-ci", subject: "Sem anexos CI", attachments: [] }]]);
export const estadoAnexos = { salvos: [], enviados: [], atraso: 0 };

export async function responderAnexos(req, res, input, responder) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && path === "/v1/me/send-as") {
    responder(200, { addresses: [{ address: "teste@exemplo.test", name: "Teste", primary: true }] });
    return true;
  }
  const detalhe = path.match(/^\/v1\/me\/messages\/([^/]+)$/);
  if (req.method === "GET" && detalhe && mensagens.has(detalhe[1])) {
    responder(200, mensagens.get(detalhe[1]));
    return true;
  }
  if (path.startsWith("/v1/me/messages/anexos-ci/attachments/")) {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="documento-ci.txt"' });
    res.end("Conteudo do arquivo de teste");
    return true;
  }
  if (req.method !== "POST" || !input.subject?.includes("Anexos CI")) return false;
  if (!["/v1/me/drafts", "/v1/me/messages/send"].includes(path)) return false;
  const fonte = input.messageAttachments;
  const selecionados = fonte?.attachmentIds.map((id) => mensagens.get(fonte.messageId)?.attachments.find((item) => item.id === id)) ?? [];
  if (selecionados.some((item) => !item)) {
    responder(404, { error: { message: "Anexo de teste indisponível" } });
    return true;
  }
  if (path.endsWith("/send")) {
    estadoAnexos.enviados.push(input);
    responder(202, { queuedId: "envio-simulado-ci", rfcMessageId: "<ci@exemplo.test>", desfazerAteMs: Date.now() + 15000 });
    return true;
  }
  if (estadoAnexos.atraso) await new Promise((resolve) => setTimeout(resolve, estadoAnexos.atraso));
  const draftId = `rascunho-anexos-ci-${estadoAnexos.salvos.length}`;
  const attachments = selecionados.map((item, indice) => ({ ...item, id: `${draftId}-${indice}` }));
  mensagens.set(draftId, { ...original, id: draftId, folderId: "pasta-rascunhos-ci", subject: input.subject, bodyText: input.text, attachments });
  if (input.draftId) mensagens.delete(input.draftId);
  estadoAnexos.salvos.push({ ...input, draftId, attachments });
  responder(200, { draftId, attachments });
  return true;
}

export async function testarAnexos(pagina, base) {
  for (const viewport of [{ width: 950, height: 900 }, { width: 768, height: 900 }, { width: 1280, height: 900 }, { width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await pagina.setViewportSize(viewport);
    await pagina.goto(`${base}/caixa?mensagem=anexos-ci`);
    const corpo = pagina.locator('iframe[title="Conteúdo da mensagem"]');
    await corpo.waitFor();
    assert.ok((await corpo.boundingBox()).height >= 160, "anexos recolhidos preservam a leitura");
    const pastas = pagina.getByRole("navigation", { name: "Pastas de e-mail" });
    assert.equal(await pastas.isVisible(), viewport.width >= 1280, "pastas fixas apenas quando ha espaco para tres colunas");
    if (viewport.width >= 768) {
      const larguraInicial = (await corpo.boundingBox()).width;
      assert.ok(larguraInicial >= 400, "leitura tem largura util em tablet e desktop");
      await pagina.getByRole("button", { name: "Ampliar leitura", exact: true }).click();
      assert.ok((await corpo.boundingBox()).width >= viewport.width - 40, "leitura ampliada usa a largura da janela");
      assert.equal(await pagina.getByRole("region", { name: "Lista de mensagens" }).isVisible(), false);
      assert.equal(await pastas.isVisible(), false);
      await pagina.getByRole("button", { name: "Restaurar colunas", exact: true }).press("Escape");
      assert.equal((await corpo.boundingBox()).width, larguraInicial, "Esc restaura as colunas");
      await pagina.getByRole("button", { name: "Ampliar leitura", exact: true }).click();
      await pagina.getByRole("button", { name: "Restaurar colunas", exact: true }).press("/");
      await pagina.waitForFunction(() => document.activeElement?.getAttribute("type") === "search");
      assert.equal(await pagina.getByRole("region", { name: "Lista de mensagens" }).isVisible(), true, "atalho de busca restaura a lista antes de focar o campo");
      if (viewport.width < 1280) {
        await pagina.getByRole("button", { name: "Abrir pastas", exact: true }).click();
        assert.equal(await pastas.isVisible(), true);
        await pagina.getByRole("button", { name: "Voltar para mensagens", exact: false }).click();
        assert.equal(await pastas.isVisible(), false);
      }
    }
    assert.equal(await pagina.locator("article details").getAttribute("open"), null);
    const resumo = pagina.locator("article summary");
    await resumo.press("Enter");
    const lista = pagina.getByRole("list", { name: "Anexos da mensagem" });
    assert.equal(await lista.getByRole("link").count(), 18);
    assert.ok((await corpo.boundingBox()).height >= 160, "abrir 18 anexos nao colapsa o corpo");
    assert.ok(await lista.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= window.innerHeight * 0.28 + 1), "anexos tem rolagem e altura limitada");
    assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "nomes longos nao alargam a tela");
    await lista.getByRole("link").last().focus();
    const download = pagina.waitForEvent("download");
    await lista.getByRole("link").last().press("Enter");
    assert.equal((await download).suggestedFilename(), "documento-ci.txt");
    await resumo.press("Space");
    assert.equal(await pagina.locator("article details").getAttribute("open"), null);
  }
  await pagina.setViewportSize({ width: 950, height: 900 });
  await pagina.goto(`${base}/caixa?mensagem=sem-anexos-ci`);
  await pagina.getByRole("heading", { name: "Sem anexos CI", exact: true }).waitFor();
  assert.equal(await pagina.locator("article details").count(), 0);
  await pagina.getByRole("region", { name: "Lista de mensagens" }).getByRole("button", { name: "Escrever", exact: true }).click();
  await pagina.getByRole("dialog", { name: "Nova mensagem", exact: true }).getByRole("button", { name: "Fechar", exact: true }).click();
  await pagina.goto(`${base}/caixa?mensagem=anexos-ci`);
  await pagina.getByRole("button", { name: "Encaminhar", exact: true }).click();
  const dialogo = pagina.getByRole("dialog", { name: "Encaminhar", exact: true });
  assert.equal(await dialogo.getByRole("button", { name: /^Remover Documento_/ }).count(), 18);
  const larguraComposicao = (await dialogo.boundingBox()).width;
  await dialogo.getByRole("textbox", { name: "Corpo da mensagem", exact: true }).fill("Texto editado para encaminhar os documentos.");
  await dialogo.getByRole("button", { name: "Ampliar composição", exact: true }).click();
  assert.ok((await dialogo.boundingBox()).width > larguraComposicao, "composicao pode ser ampliada");
  assert.equal(await dialogo.getByRole("textbox", { name: "Corpo da mensagem", exact: true }).innerText(), "Texto editado para encaminhar os documentos.");
  await dialogo.getByRole("button", { name: "Restaurar composição", exact: true }).click();
  assert.equal((await dialogo.boundingBox()).width, larguraComposicao);
  await pagina.setViewportSize({ width: 844, height: 390 });
  const editor = await dialogo.getByRole("textbox", { name: "Corpo da mensagem", exact: true }).boundingBox();
  const arquivos = await dialogo.getByRole("region", { name: "Anexos para enviar" }).boundingBox();
  assert.ok(editor.y + editor.height <= arquivos.y + 1, "editor e anexos nao se sobrepoem em janela baixa");
  await dialogo.getByRole("button", { name: "Enviar", exact: true }).scrollIntoViewIfNeeded();
  const botaoEnviar = await dialogo.getByRole("button", { name: "Enviar", exact: true }).boundingBox();
  assert.ok(botaoEnviar.y >= 0 && botaoEnviar.y + botaoEnviar.height <= 390, "enviar continua acessivel pela rolagem");
  await pagina.setViewportSize({ width: 950, height: 900 });
  await dialogo.getByRole("button", { name: /^Remover Documento_1_/ }).click();
  assert.equal(await dialogo.getByRole("button", { name: /^Remover Documento_/ }).count(), 17);
  await dialogo.getByText("rascunho salvo", { exact: true }).waitFor();
  const salvo = estadoAnexos.salvos.at(-1);
  assert.equal(salvo.attachments.length, 17);
  assert.equal(original.attachments.length, 18, "remover da composicao nao altera a origem");
  await dialogo.getByRole("button", { name: "Fechar", exact: true }).click();
  await pagina.goto(`${base}/caixa?mensagem=${salvo.draftId}`);
  const retomado = pagina.getByRole("dialog", { name: "Rascunho", exact: true });
  await retomado.waitFor();
  assert.equal(await retomado.getByRole("button", { name: /^Remover Documento_/ }).count(), 17);
  await retomado.getByRole("combobox").first().fill("destino@exemplo.test");
  await retomado.getByRole("combobox").first().press("Enter");
  estadoAnexos.atraso = 800;
  await retomado.getByText("salvando…", { exact: true }).waitFor();
  await retomado.getByRole("button", { name: "Enviar", exact: true }).click();
  await retomado.waitFor({ state: "hidden" });
  assert.equal(estadoAnexos.enviados.length, 1, "envio aguarda o autosave sem duplicar");
  assert.equal(estadoAnexos.enviados[0].messageAttachments.attachmentIds.length, 17);
  assert.equal(estadoAnexos.enviados[0].messageAttachments.messageId, estadoAnexos.salvos.at(-1).draftId);
  assert.equal(estadoAnexos.enviados[0].inReplyToMessageId, undefined);
  estadoAnexos.atraso = 0;
  console.log("PASSOU — anexos: leitura responsiva, download, encaminhamento, remocao, rascunho e envio durante autosave");
}
