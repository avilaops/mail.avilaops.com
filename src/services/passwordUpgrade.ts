import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { hashPassword, needsRehash } from "../lib/password.js";

const log = createLogger("password-upgrade");

/**
 * Troca o hash bcrypt legado pelo scrypt na primeira autenticacao correta.
 *
 * Chamado DEPOIS de `verifyPassword` devolver true, com a senha em claro que
 * acabou de ser validada — e o unico momento em que ela existe. Roda em
 * segundo plano: o login nao espera, e uma falha aqui so adia a troca para o
 * proximo login.
 */
export function upgradeHashIfNeeded(mailboxId: string, plain: string, hashAtual: string): void {
  if (!needsRehash(hashAtual)) return;

  void (async () => {
    try {
      const novo = await hashPassword(plain);
      // Condicao no hash atual: se a senha mudou entre a verificacao e agora,
      // nada e sobrescrito.
      const resultado = await prisma.mailbox.updateMany({
        where: { id: mailboxId, passwordHash: hashAtual },
        data: { passwordHash: novo },
      });
      if (resultado.count > 0) log.info("hash de senha migrado para scrypt", { mailboxId });
    } catch (erro) {
      log.warn("falha ao migrar hash de senha", { mailboxId, erro: erro instanceof Error ? erro.message : String(erro) });
    }
  })();
}
