import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function responderLayout(req, responder) {
  if (new URL(req.url, "http://localhost").pathname !== "/v1/me/messages/leitura-layout-ci") return false;
  responder(200, {
    id: "leitura-layout-ci", folderId: "pasta-entrada-ci", threadKey: null,
    fromAddress: "contabilidade@exemplo.test", fromName: "Contabilidade — Empresa de teste",
    toAddresses: [{ address: "teste@exemplo.test" }], ccAddresses: [],
    subject: "Aviso de pagamento e documentos da sua conta", snippet: "Documentos disponíveis",
    seen: true, flagged: false, answered: false, hasAttachments: false, sizeBytes: 1000,
    senderVerified: true, receivedAt: "2026-11-09T11:30:00Z", bodyText: null,
    bodyHtml: '<p>Olá, Nicolas.</p><p>Seus documentos estão disponíveis em <a id="link-comum" href="https://exemplo.test/documentos" target="_blank">nossa central de atendimento</a>.</p><p>Consulte o documento para conferir os detalhes da sua conta.</p><p><a id="cta-original" href="https://exemplo.test/conta" style="display:inline-block;padding:12px 24px;background:#115e59;color:#fff;border-radius:4px">Acessar minha conta</a></p><p><a href="https://exemplo.test/termos">Termos de uso</a> · <a href="https://exemplo.test/privacidade">Privacidade</a></p><img data-src="https://exemplo.test/rastreio.png" width="600" height="400" alt="Imagem externa bloqueada">',
    blockedRemoteImages: 1, attachments: [], convite: null,
  });
  return true;
}

export async function testarLayoutLeitura(pagina, base) {
  const viewportOriginal = pagina.viewportSize();
  const largura = () => pagina.locator("#mail-message-list").evaluate((el) => el.getBoundingClientRect().width);
  const esperarLargura = (valor) => pagina.waitForFunction((alvo) => Math.abs(document.querySelector("#mail-message-list").getBoundingClientRect().width - alvo) < 2, valor);
  await pagina.setViewportSize({ width: 1200, height: 900 });
  await pagina.goto(`${base}/caixa?mensagem=leitura-layout-ci`);
  await pagina.getByRole("heading", { name: "Aviso de pagamento e documentos da sua conta", exact: true }).waitFor();
  const divisoria = pagina.getByRole("separator", { name: "Ajustar largura da lista de e-mails" });
  await divisoria.waitFor({ timeout: 5000 });
  const inicial = await largura();
  const posicao = await divisoria.boundingBox();
  await pagina.mouse.move(posicao.x + posicao.width / 2, posicao.y + 180);
  await pagina.mouse.down();
  await pagina.mouse.move(posicao.x + posicao.width / 2 + 140, posicao.y + 180, { steps: 10 });
  await pagina.mouse.up();
  await esperarLargura(inicial + 140);
  await pagina.reload();
  await esperarLargura(inicial + 140);
  await divisoria.press("ArrowRight");
  await esperarLargura(inicial + 150);
  await divisoria.press("End");
  await esperarLargura(600);
  await pagina.setViewportSize({ width: 850, height: 900 });
  await esperarLargura(530);
  assert.ok((await pagina.locator("#mail-reading-pane").boundingBox()).width >= 319, "leitura conserva espaço ao reduzir a janela");
  await pagina.setViewportSize({ width: 1200, height: 900 });
  await esperarLargura(600);
  await divisoria.press("Home");
  await esperarLargura(220);
  await divisoria.press("Enter");
  await esperarLargura(inicial);
  await divisoria.press("ArrowRight");
  await divisoria.dblclick();
  await esperarLargura(inicial);
  assert.equal(await pagina.evaluate(() => localStorage.getItem("avila-mail-largura-lista")), null, "redefinir remove a preferência salva");

  const iframe = pagina.locator('iframe[title="Conteúdo da mensagem"]');
  assert.equal(await iframe.getAttribute("sandbox"), "allow-popups allow-popups-to-escape-sandbox");
  const documento = pagina.frameLocator('iframe[title="Conteúdo da mensagem"]');
  const link = documento.locator("#link-comum");
  await link.waitFor();
  const estilo = await link.evaluate((el) => ({ display: getComputedStyle(el).display, padding: getComputedStyle(el).padding, fundo: getComputedStyle(el).backgroundColor }));
  assert.deepEqual(estilo, { display: "inline", padding: "0px", fundo: "rgba(0, 0, 0, 0)" }, "links de texto não viram botões");
  assert.equal(await documento.locator("#cta-original").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(17, 94, 89)", "botão original do remetente mantém sua aparência");
  assert.ok(await documento.locator("body").evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 15), "texto tem tamanho confortável");
  assert.equal(await documento.locator("img[data-src]").isVisible(), false, "imagem remota continua bloqueada");
  assert.ok((await pagina.getByRole("button", { name: "Responder", exact: true }).boundingBox()).height >= 36);
  if (process.env.MAIL_LAYOUT_SCREENSHOTS) {
    mkdirSync(process.env.MAIL_LAYOUT_SCREENSHOTS, { recursive: true });
    await pagina.screenshot({ path: join(process.env.MAIL_LAYOUT_SCREENSHOTS, "leitura-desktop.png") });
  }
  await pagina.setViewportSize({ width: 390, height: 844 });
  assert.equal(await divisoria.isVisible(), false);
  assert.equal(await pagina.getByRole("button", { name: "Ampliar leitura", exact: true }).isVisible(), false, "celular já usa a largura inteira para leitura");
  assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "leitura não causa rolagem horizontal na página");
  assert.ok((await iframe.boundingBox()).width >= 370);
  if (process.env.MAIL_LAYOUT_SCREENSHOTS) await pagina.screenshot({ path: join(process.env.MAIL_LAYOUT_SCREENSHOTS, "leitura-mobile.png") });
  await pagina.getByRole("button", { name: "Voltar para a lista", exact: true }).click();
  assert.equal(Math.round(await largura()), 390, "lista usa toda a largura no celular");
  await pagina.setViewportSize(viewportOriginal);
  console.log("PASSOU — divisória: arraste, persistência, teclado, limites, redefinição e celular; leitor: links e isolamento");
}
