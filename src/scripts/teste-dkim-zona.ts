/**
 * Confere, para cada domínio do mail, se o CNAME do cliente e o TXT da nossa
 * zona estão de pé: `tsx src/scripts/teste-dkim-zona.ts`
 *
 * Existe porque o painel dava DKIM verde olhando só o CNAME, e o alvo dele,
 * que mora na nossa zona, podia estar vazio.
 */
import { resolveCname, resolveTxt } from "node:dns/promises";
import { prisma } from "../lib/db.js";
import { dkimCnameTarget } from "../mta/dkim.js";

const dominios = await prisma.mailDomain.findMany({
  select: { name: true, dkimSelector: true, dkimPublicKey: true },
  orderBy: { name: "asc" },
});

let quebrados = 0;

for (const d of dominios) {
  const alvo = dkimCnameTarget(d.name);

  const cname = await resolveCname(`${d.dkimSelector}._domainkey.${d.name}`).catch(() => []);
  const apontaCerto = cname.some((t) => t.toLowerCase() === alvo.toLowerCase());

  const txt = await resolveTxt(alvo).catch(() => []);
  const temChave = Boolean(d.dkimPublicKey) && txt.some((p) => p.join("").includes(d.dkimPublicKey!));

  const ok = apontaCerto && temChave;
  if (!ok) quebrados++;

  console.log(
    `  ${ok ? "ok  " : "FALHA"} ${d.name.padEnd(26)} cname=${apontaCerto ? "ok" : "nao"} chave=${temChave ? "ok" : "nao"}`,
  );
}

console.log(quebrados === 0 ? "\ntodos assinam" : `\n${quebrados} domínio(s) não assinam`);
await prisma.$disconnect();
process.exit(quebrados === 0 ? 0 : 1);
