"use client";

import { useState } from "react";

/**
 * Tudo que um cliente precisa para usar a caixa fora do webmail: servidores,
 * portas, segurança e o passo a passo dos programas que ele realmente usa.
 *
 * É a página que o suporte manda em vez de responder a mesma pergunta cem
 * vezes — por isso ela é pública, imprimível e tem "copiar" em tudo que a
 * pessoa vai digitar num celular.
 */

interface Props {
  host: string;
}

function Copiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(texto).then(() => {
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        });
      }}
      className="ml-2 rounded-md border border-[var(--color-borda)] px-2 py-0.5 text-xs text-[var(--color-texto-fraco)] transition hover:bg-[var(--color-fundo-suave)]"
    >
      {copiado ? "Copiado ✓" : "Copiar"}
    </button>
  );
}

function Passos({ titulo, passos }: { titulo: string; passos: string[] }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--color-borda)]">
      <button
        type="button"
        onClick={() => setAberto(!aberto)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
      >
        {titulo}
        <span className="text-[var(--color-texto-fraco)]">{aberto ? "−" : "+"}</span>
      </button>
      {aberto && (
        <ol className="space-y-1.5 border-t border-[var(--color-borda)] px-4 py-3 text-sm text-[var(--color-texto-fraco)]">
          {passos.map((passo, indice) => (
            <li key={indice} className="flex gap-2">
              <span className="w-5 shrink-0 text-right">{indice + 1}.</span>
              <span>{passo}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function GuiaConfiguracao({ host }: Props) {
  const servidores: { servico: string; porta: number; seguranca: string; nota?: string }[] = [
    { servico: "IMAP (recebimento)", porta: 993, seguranca: "SSL/TLS", nota: "recomendado" },
    { servico: "IMAP (recebimento)", porta: 143, seguranca: "STARTTLS" },
    { servico: "SMTP (envio)", porta: 587, seguranca: "STARTTLS", nota: "recomendado" },
    { servico: "SMTP (envio)", porta: 465, seguranca: "SSL/TLS", nota: "se a 587 falhar" },
    { servico: "POP3 (recebimento)", porta: 995, seguranca: "SSL/TLS", nota: "só para um aparelho" },
    { servico: "POP3 (recebimento)", porta: 110, seguranca: "STARTTLS" },
  ];

  const celula = "px-3 py-2 text-sm";

  return (
    <main className="min-h-full bg-[var(--color-fundo-suave)] px-6 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Configurar seu e-mail</h1>
        <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
          No celular, no Outlook, no Gmail ou em qualquer programa. Os dados são os mesmos para
          todas as caixas da Ávila Ops.
        </p>

        {/* ------ Servidores ------ */}
        <section className="mt-8 rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-5">
          <h2 className="text-base font-semibold">Servidores e portas</h2>
          <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
            Servidor de entrada e de saída:{" "}
            <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm dark:bg-white/10">{host}</code>
            <Copiar texto={host} />
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-borda)] text-left text-xs uppercase tracking-wide text-[var(--color-texto-fraco)]">
                  <th className={celula}>Serviço</th>
                  <th className={celula}>Porta</th>
                  <th className={celula}>Segurança</th>
                  <th className={celula}></th>
                </tr>
              </thead>
              <tbody>
                {servidores.map((linha) => (
                  <tr key={`${linha.servico}-${linha.porta}`} className="border-b border-[var(--color-borda)] last:border-0">
                    <td className={celula}>{linha.servico}</td>
                    <td className={`${celula} font-mono`}>{linha.porta}</td>
                    <td className={celula}>{linha.seguranca}</td>
                    <td className={`${celula} text-xs text-[var(--color-texto-fraco)]`}>{linha.nota ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="mt-4 grid gap-2 border-t border-[var(--color-borda)] pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[var(--color-texto-fraco)]">Usuário</dt>
              <dd className="font-medium">seu endereço completo (ex.: contato@suaempresa.com.br)</dd>
            </div>
            <div>
              <dt className="text-[var(--color-texto-fraco)]">Senha</dt>
              <dd className="font-medium">a senha da caixa</dd>
            </div>
            <div>
              <dt className="text-[var(--color-texto-fraco)]">Autenticação</dt>
              <dd className="font-medium">senha normal (a mesma para entrada e saída)</dd>
            </div>
            <div>
              <dt className="text-[var(--color-texto-fraco)]">Webmail</dt>
              <dd className="font-medium">
                <a href={`https://${host}`} className="underline underline-offset-2">
                  {host}
                </a>
              </dd>
            </div>
          </dl>
        </section>

        {/* ------ Avisos ------ */}
        <section className="mt-6 space-y-3">
          <div className="rounded-xl border-l-4 border-[var(--color-realce)] bg-[var(--color-superficie)] px-4 py-3 text-sm">
            <p className="font-medium">Prefira IMAP</p>
            <p className="mt-0.5 text-[var(--color-texto-fraco)]">
              Com IMAP as mensagens ficam no servidor e aparecem iguais no celular, no computador e no
              webmail. O POP3 baixa e apaga do servidor — só faz sentido num aparelho único.
            </p>
          </div>
          <div className="rounded-xl border-l-4 border-amber-400 bg-[var(--color-superficie)] px-4 py-3 text-sm">
            <p className="font-medium">Outlook reclamando do envio?</p>
            <p className="mt-0.5 text-[var(--color-texto-fraco)]">
              O aplicativo do Outlook (principalmente no celular) tem um defeito conhecido com STARTTLS na
              porta 587. Se o envio falhar, troque para a porta <strong>465</strong> com SSL/TLS.
            </p>
          </div>
          <div className="rounded-xl border-l-4 border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-3 text-sm">
            <p className="font-medium">Registros DNS do seu domínio</p>
            <p className="mt-0.5 text-[var(--color-texto-fraco)]">
              MX, SPF, DKIM e DMARC são entregues pela Ávila Ops na contratação, prontos para copiar.
              Quem cuida do domínio é quem publica — e o e-mail só chega depois que eles estão no ar.
            </p>
          </div>
        </section>

        {/* ------ Tutoriais ------ */}
        <section className="mt-8">
          <h2 className="text-base font-semibold">Passo a passo por aplicativo</h2>
          <div className="mt-3 space-y-2">
            <Passos
              titulo="iPhone e iPad (Mail da Apple)"
              passos={[
                "Ajustes → Mail → Contas → Adicionar Conta → Outra → Adicionar Conta de E-mail.",
                "Nome, seu endereço completo, a senha da caixa e uma descrição. Toque em Seguinte.",
                `Escolha IMAP. Servidor de entrada e de saída: ${host}. Usuário: o endereço completo. Senha: a da caixa.`,
                "Toque em Seguinte e depois em Salvar. O iPhone escolhe as portas 993 e 587 sozinho.",
              ]}
            />
            <Passos
              titulo="Android (aplicativo Gmail)"
              passos={[
                "Gmail → foto de perfil → Adicionar outra conta → Outro.",
                "Digite o endereço completo → Seguinte → escolha Pessoal (IMAP).",
                `Senha da caixa. Servidor de entrada: ${host}, porta 993, segurança SSL/TLS.`,
                `Servidor de saída: ${host}, porta 587, STARTTLS, com autenticação marcada.`,
              ]}
            />
            <Passos
              titulo="Outlook (Windows e Mac)"
              passos={[
                "Arquivo → Adicionar Conta → digite o endereço → Opções avançadas → Configurar minha conta manualmente → IMAP.",
                `Entrada: ${host}, porta 993, criptografia SSL/TLS.`,
                `Saída: ${host}, porta 587, STARTTLS (se falhar, 465 com SSL/TLS).`,
                "Senha da caixa → Conectar. Se pedir, marque que o servidor de saída requer autenticação.",
              ]}
            />
            <Passos
              titulo="Thunderbird"
              passos={[
                "Configurações → Configurações de conta → Ações de contas → Adicionar conta de e-mail.",
                "Nome, endereço completo e senha → Continuar → Configurar manualmente.",
                `Entrada IMAP: ${host}, 993, SSL/TLS, senha normal. Saída SMTP: ${host}, 587, STARTTLS, senha normal.`,
                "Testar → Concluído.",
              ]}
            />
            <Passos
              titulo="Enviar pelo Gmail da web com seu endereço profissional"
              passos={[
                "Gmail → engrenagem → Ver todas as configurações → Contas e importação → Enviar e-mail como → Adicionar outro endereço.",
                "Nome e seu endereço profissional; desmarque Tratar como alias se quiser respostas separadas.",
                `Servidor SMTP: ${host}, porta 587, usuário = endereço completo, senha da caixa, conexão TLS.`,
                "Confirme pelo código que chega na sua caixa (abra o webmail para ver).",
              ]}
            />
          </div>
        </section>

        <p className="mt-10 text-center text-sm text-[var(--color-texto-fraco)]">
          <a href="/entrar" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Entrar no webmail
          </a>
        </p>
      </div>
    </main>
  );
}
