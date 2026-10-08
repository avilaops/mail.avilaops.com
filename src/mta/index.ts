import type { Server } from "node:net";
import type { SMTPServer } from "smtp-server";
import { assertConfig, config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import { disconnect } from "../lib/db.js";
import { ensureStorageDir } from "../lib/storage.js";
import { createInboundServer } from "./inbound.js";
import { createSubmissionServer } from "./submission.js";
import { startQueueWorker } from "./queue.js";
import { iniciarManutencao } from "./maintenance.js";
import { iniciarWorkerMigracao } from "../services/migracao.js";
import { criarServidorPop3 } from "./pop3.js";
import { criarServidorImap } from "./imap.js";
import { carregarTls } from "./tls.js";

const log = createLogger("mta");

/**
 * Processo do MTA: entrada (25), submission (587/465), POP3 (110/995),
 * IMAP (143/993), worker da fila e faxina diaria.
 *
 * Todos no mesmo processo de proposito. O servidor e compartilhado com o resto
 * da stack e cada processo Node a mais custa ~60 MB de um orcamento apertado.
 */


function listen(server: SMTPServer, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on("error", (error) => log.error(`erro no servidor ${label}`, { error: error.message }));
    server.listen(port, () => {
      log.info(`${label} escutando`, { port });
      resolve();
    });
    server.once("error", reject);
  });
}

/**
 * Escuta de servidor TCP puro (POP3). O `listen` acima e do smtp-server, que
 * tem interface propria; aqui e o `net.Server` do Node.
 */
function escutarSimples(server: Server, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.on("error", (error) => log.error(`erro no servidor ${label}`, { error: error.message }));
    server.listen(port, () => {
      log.info(`${label} escutando`, { port });
      resolve();
    });
    server.once("error", reject);
  });
}

async function main(): Promise<void> {
  assertConfig("mta");
  await ensureStorageDir();

  const tls = carregarTls();

  const inbound = createInboundServer({ tls });
  const pop3 = criarServidorPop3({ seguro: false, tls });
  const pop3Tls = tls ? criarServidorPop3({ seguro: true, tls }) : null;
  const imap = criarServidorImap({ seguro: false, tls });
  const imapTls = tls ? criarServidorImap({ seguro: true, tls }) : null;
  const submission = createSubmissionServer({ secure: false, tls });
  const submissionTls = tls ? createSubmissionServer({ secure: true, tls }) : null;

  await listen(inbound, config.ports.inbound, "smtp-entrada");
  await listen(submission, config.ports.submission, "smtp-submission");
  if (submissionTls) await listen(submissionTls, config.ports.submissionTls, "smtp-submission-tls");

  // POP3 e o que o Gmail usa em "verificar e-mails de outras contas".
  await escutarSimples(pop3, config.ports.pop3, "pop3");
  if (pop3Tls) await escutarSimples(pop3Tls, config.ports.pop3Tls, "pop3-tls");

  // IMAP e o que Outlook, Apple Mail e os apps de celular falam.
  await escutarSimples(imap, config.ports.imap, "imap");
  if (imapTls) await escutarSimples(imapTls, config.ports.imapTls, "imap-tls");

  const stopWorker = startQueueWorker();
  const stopManutencao = iniciarManutencao();
  const stopMigracao = iniciarWorkerMigracao();

  log.info("mta no ar", {
    hostname: config.hostname,
    relayDriver: config.relay.driver,
    storageDir: config.storageDir,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("encerrando", { signal });

    stopWorker();
    stopManutencao();
    stopMigracao();
    await Promise.all(
      [inbound, submission, submissionTls, pop3, pop3Tls, imap, imapTls]
        .filter((server): server is SMTPServer | Server => server !== null)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.error("falha fatal na subida do mta", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
