/**
 * Popula um ambiente de desenvolvimento: um dominio, uma caixa e uma mensagem
 * na entrada. Serve para subir a interface com conteudo de verdade sem
 * depender de e-mail chegando de fora.
 *
 *   MAIL_DATABASE_URL=... npx tsx src/scripts/seed-dev.ts
 *
 * Nunca rodar contra o banco de producao: cria caixa com senha conhecida.
 */

import { createDomain, createMailbox } from "../services/provisioning.js";
import { deliverToMailbox, resolveRecipient } from "../mta/deliver-local.js";
import { prisma } from "../lib/db.js";
import { ensureStorageDir } from "../lib/storage.js";

const DOMINIO = process.env.SEED_DOMAIN ?? "brilhax.com.br";
const CAIXA = process.env.SEED_MAILBOX ?? "contato";
const SENHA = process.env.SEED_PASSWORD ?? "SenhaDeTeste12345";

await ensureStorageDir();

const dominio = await createDomain({ domain: DOMINIO, clientRef: "seed" });
await prisma.mailDomain.update({ where: { name: DOMINIO }, data: { status: "active" } });

const caixa = await createMailbox({
  domain: DOMINIO,
  username: CAIXA,
  password: SENHA,
  quotaGb: 5,
  displayName: "Contato",
});

const mensagens = [
  {
    de: "Ana Souza <ana@clientefeliz.com.br>",
    assunto: "Proposta aprovada",
    corpo: "<p>Boa tarde! Aprovamos a proposta. Podemos comecar na segunda?</p><p>Abraco,<br>Ana</p>",
  },
  {
    de: "Financeiro <financeiro@fornecedor.com.br>",
    assunto: "Boleto de agosto disponivel",
    corpo: '<p>Seu boleto ja esta disponivel.</p><img src="https://rastreador.exemplo.com/pixel.gif" alt="">',
  },
  {
    de: "Suporte <suporte@ferramenta.io>",
    assunto: "Novidades da versao 3.2",
    corpo: "<p>Confira o que mudou nesta versao.</p>",
  },
];

const destino = await resolveRecipient(`${CAIXA}@${DOMINIO}`);
if (destino.kind !== "mailbox") throw new Error("caixa nao resolveu");

for (const [indice, mensagem] of mensagens.entries()) {
  const bruta = Buffer.from(
    [
      `From: ${mensagem.de}`,
      `To: ${CAIXA}@${DOMINIO}`,
      `Subject: ${mensagem.assunto}`,
      `Date: ${new Date(Date.now() - indice * 3_600_000).toUTCString()}`,
      `Message-ID: <seed-${indice}@exemplo.com>`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset=utf-8',
      "",
      mensagem.corpo,
      "",
    ].join("\r\n"),
  );

  // Estado atualizado a cada volta: a quota do laco anterior ja foi consumida.
  const atual = await resolveRecipient(`${CAIXA}@${DOMINIO}`);
  if (atual.kind === "mailbox") await deliverToMailbox(atual, bruta, null);
}

console.log(`\nAmbiente pronto:`);
console.log(`  dominio ....... ${dominio.domain}`);
console.log(`  caixa ......... ${caixa.address}`);
console.log(`  senha ......... ${SENHA}`);
console.log(`  mensagens ..... ${mensagens.length} + boas-vindas\n`);

await prisma.$disconnect();
