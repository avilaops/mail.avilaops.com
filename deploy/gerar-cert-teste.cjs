/**
 * Gera um certificado autoassinado para o teste de integracao e imprime os
 * caminhos (cert na primeira linha, chave na segunda).
 *
 * Por que passar pelo Node em vez de chamar openssl direto do shell: no Git
 * Bash do Windows, o argumento "/CN=127.0.0.1" e confundido com caminho e vira
 * "C:/Program Files/Git/CN=...". Desligar essa conversao (MSYS_NO_PATHCONV)
 * quebra os OUTROS argumentos, que sao caminhos de verdade. O execFileSync do
 * Node nao passa pelo shell, entao nada e reescrito.
 *
 * O certificado precisa de subjectAltName com IP:127.0.0.1: o teste de
 * migracao conecta no proprio servidor como se fosse o provedor antigo, e
 * cliente IMAP serio confere o nome do host contra o certificado.
 */

const { execFileSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const dir = mkdtempSync(join(tmpdir(), "avila-mail-cert-"));
const cert = join(dir, "teste.crt");
const key = join(dir, "teste.key");

execFileSync(
  "openssl",
  [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore" },
);

process.stdout.write(`${cert}\n${key}\n`);
