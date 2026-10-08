import { PrismaClient } from "@prisma/client";

/**
 * Cliente Prisma unico do processo. O MTA e a API rodam como processos
 * separados e cada um abre seu proprio pool contra o mesmo banco.
 */
export const prisma = new PrismaClient({
  log: process.env.MAIL_LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
