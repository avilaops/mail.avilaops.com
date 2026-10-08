"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/cliente";
import { ConfiguracaoDispositivos } from "./ConfiguracaoDispositivos";
import { AvisosDeMensagem } from "./AvisosDeMensagem";
import { ChavesDeApi } from "./ChavesDeApi";
import { FiltrosCaixa } from "./FiltrosCaixa";
import { MigracaoCaixa } from "./MigracaoCaixa";
import { VerificacaoDuasEtapas } from "./VerificacaoDuasEtapas";
import { CampoSenha } from "./CampoSenha";

/**
 * Tela de conta: perfil, assinatura, ausencia, preferencias e dispositivos.
 *
 * Cada bloco salva sozinho, com botao proprio. Um "Salvar" unico no rodape
 * pareceria mais limpo e faria o cliente que so queria desligar a resposta
 * automatica rolar a pagina inteira ate achar o botao.
 */

interface Preferencias {
  signatureHtml: string | null;
  signatureText: string | null;
  autoReplyEnabled: boolean;
  autoReplySubject: string | null;
  autoReplyBody: string | null;
  autoReplyUntil: string | null;
  showRemoteImages: boolean;
  messagesPerPage: number;
}

interface Perfil {
  displayName: string | null;
  recoveryEmail: string | null;
}

interface Dispositivo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  /** "Galaxy S23 · Android 14 · Chrome", montado pela API a partir do User-Agent. */
  device: string;
  deviceName: string;
  os: string | null;
  browser: string | null;
  /** "São José do Rio Preto, SP · Brazil" — null quando o IP não diz. */
  location: string | null;
  lastUsedAt: string;
  createdAt: string;
}

type Estado = "parado" | "salvando" | "salvo" | "erro";

function Secao({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-[var(--color-borda)] px-8 py-7">
      <h2 className="text-base font-semibold">{titulo}</h2>
      {descricao && <p className="mt-0.5 text-sm text-[var(--color-texto-fraco)]">{descricao}</p>}
      <div className="mt-4 max-w-lg space-y-4">{children}</div>
    </section>
  );
}

function BotaoSalvar({ estado, onClick }: { estado: Estado; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onClick}
        disabled={estado === "salvando"}
        className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
      >
        {estado === "salvando" ? "Salvando…" : "Salvar"}
      </button>
      {estado === "salvo" && <span className="text-xs text-emerald-700">salvo</span>}
    </div>
  );
}

const campo =
  "w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm outline-none transition focus:border-[var(--color-realce)]";

export function PainelConta() {
  const [prefs, setPrefs] = useState<Preferencias | null>(null);
  const [perfil, setPerfil] = useState<Perfil>({ displayName: "", recoveryEmail: "" });
  const [dispositivos, setDispositivos] = useState<Dispositivo[]>([]);
  const [endereco, setEndereco] = useState("");
  const [ehAdmin, setEhAdmin] = useState(false);

  const [estadoPerfil, setEstadoPerfil] = useState<Estado>("parado");
  const [estadoAssinatura, setEstadoAssinatura] = useState<Estado>("parado");
  const [estadoAusencia, setEstadoAusencia] = useState<Estado>("parado");
  const [estadoPrefs, setEstadoPrefs] = useState<Estado>("parado");

  const [senhaAtual, setSenhaAtual] = useState("");
  const [senhaNova, setSenhaNova] = useState("");
  const [estadoSenha, setEstadoSenha] = useState<Estado>("parado");

  const [erro, setErro] = useState<string | null>(null);

  const carregarDispositivos = useCallback(async () => {
    const dados = await api<{ sessions: Dispositivo[] }>("/me/sessions");
    setDispositivos(dados.sessions);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [preferencias, caixa] = await Promise.all([
          api<Preferencias>("/me/settings"),
          api<{ displayName: string | null; address: string; isAdmin?: boolean }>("/me"),
        ]);
        setPrefs(preferencias);
        setPerfil((atual) => ({ ...atual, displayName: caixa.displayName ?? "" }));
        setEndereco(caixa.address);
        setEhAdmin(caixa.isAdmin === true);
        await carregarDispositivos();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao carregar a conta.");
      }
    })();
  }, [carregarDispositivos]);

  async function salvar(
    corpo: Record<string, unknown>,
    rota: string,
    metodo: string,
    marcar: (estado: Estado) => void,
  ) {
    marcar("salvando");
    setErro(null);
    try {
      const salvo = await api<Preferencias | Perfil>(rota, { method: metodo, body: corpo });
      if (rota === "/me/settings") setPrefs(salvo as Preferencias);
      marcar("salvo");
      setTimeout(() => marcar("parado"), 2500);
    } catch (falha) {
      marcar("erro");
      setErro(falha instanceof Error ? falha.message : "Não foi possível salvar.");
    }
  }

  async function trocarSenha() {
    setEstadoSenha("salvando");
    setErro(null);
    try {
      await api("/me/password", {
        method: "POST",
        body: { currentPassword: senhaAtual, newPassword: senhaNova },
      });
      setSenhaAtual("");
      setSenhaNova("");
      setEstadoSenha("salvo");
      // A troca derruba as outras sessoes no servidor; a lista precisa refletir.
      await carregarDispositivos();
      setTimeout(() => setEstadoSenha("parado"), 3000);
    } catch (falha) {
      setEstadoSenha("erro");
      setErro(falha instanceof Error ? falha.message : "Não foi possível trocar a senha.");
    }
  }

  if (!prefs) {
    return <p className="px-8 py-10 text-sm text-[var(--color-texto-fraco)]">Carregando…</p>;
  }

  return (
    <div className="rolagem-fina h-full overflow-y-auto">
      <header className="flex items-center justify-between border-b border-[var(--color-borda)] px-8 py-5">
        <h1 className="text-lg font-semibold">Conta</h1>
        <div className="flex gap-2">
          {ehAdmin && (
            <a
              href="/admin"
              className="rounded-md border border-[var(--color-borda)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-fundo-suave)]"
            >
              Administração
            </a>
          )}
          <a
            href="/caixa"
            className="rounded-md border border-[var(--color-borda)] px-3 py-1.5 text-sm transition hover:bg-[var(--color-fundo-suave)]"
          >
            Voltar à caixa
          </a>
        </div>
      </header>

      {erro && (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-8 py-2.5 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      <Secao titulo="Identificação" descricao="O nome que aparece para quem recebe suas mensagens.">
        <div>
          <label htmlFor="nome" className="mb-1.5 block text-sm font-medium">
            Nome de exibição
          </label>
          <input
            id="nome"
            className={campo}
            value={perfil.displayName ?? ""}
            onChange={(evento) => setPerfil({ ...perfil, displayName: evento.target.value })}
            placeholder="Ex.: Contato Brilhax"
          />
        </div>

        <div>
          <label htmlFor="recuperacao" className="mb-1.5 block text-sm font-medium">
            E-mail de recuperação
          </label>
          <input
            id="recuperacao"
            type="email"
            className={campo}
            value={perfil.recoveryEmail ?? ""}
            onChange={(evento) => setPerfil({ ...perfil, recoveryEmail: evento.target.value })}
            placeholder="seu.email.pessoal@gmail.com"
          />
          {/* Sem esse endereco, toda troca de senha vira chamado de suporte. */}
          <p className="mt-1.5 text-xs text-[var(--color-texto-fraco)]">
            Um endereço fora daqui. É por ele que você recupera o acesso se esquecer a senha — sem
            ele, só a Ávila Ops consegue redefinir.
          </p>
        </div>

        <BotaoSalvar
          estado={estadoPerfil}
          onClick={() =>
            void salvar(
              { displayName: perfil.displayName, recoveryEmail: perfil.recoveryEmail },
              "/me/profile",
              "PATCH",
              setEstadoPerfil,
            )
          }
        />
      </Secao>

      <Secao titulo="Assinatura" descricao="Vai no fim das mensagens que você enviar.">
        <textarea
          className={`${campo} min-h-28 resize-y font-mono text-xs`}
          value={prefs.signatureHtml ?? ""}
          onChange={(evento) => setPrefs({ ...prefs, signatureHtml: evento.target.value })}
          placeholder="Seu nome&#10;Cargo · Empresa&#10;(00) 00000-0000"
        />
        <p className="text-xs text-[var(--color-texto-fraco)]">
          Aceita HTML simples: <code>&lt;b&gt;</code>, <code>&lt;a&gt;</code>, <code>&lt;br&gt;</code>.
          Script e conteúdo ativo são removidos ao salvar.
        </p>
        <BotaoSalvar
          estado={estadoAssinatura}
          onClick={() => void salvar({ signatureHtml: prefs.signatureHtml }, "/me/settings", "PUT", setEstadoAssinatura)}
        />
      </Secao>

      <Secao titulo="Resposta automática" descricao="Avisa quem escrever que você está ausente.">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={prefs.autoReplyEnabled}
            onChange={(evento) => setPrefs({ ...prefs, autoReplyEnabled: evento.target.checked })}
          />
          Responder automaticamente
        </label>

        {prefs.autoReplyEnabled && (
          <>
            <div>
              <label htmlFor="assunto-ausencia" className="mb-1.5 block text-sm font-medium">
                Assunto
              </label>
              <input
                id="assunto-ausencia"
                className={campo}
                value={prefs.autoReplySubject ?? ""}
                onChange={(evento) => setPrefs({ ...prefs, autoReplySubject: evento.target.value })}
                placeholder="Ausente até dia 20"
              />
            </div>

            <div>
              <label htmlFor="corpo-ausencia" className="mb-1.5 block text-sm font-medium">
                Mensagem
              </label>
              <textarea
                id="corpo-ausencia"
                className={`${campo} min-h-24 resize-y`}
                value={prefs.autoReplyBody ?? ""}
                onChange={(evento) => setPrefs({ ...prefs, autoReplyBody: evento.target.value })}
                placeholder="Estou fora até dia 20. Para urgências, fale com..."
              />
            </div>

            <div>
              <label htmlFor="ate-ausencia" className="mb-1.5 block text-sm font-medium">
                Desligar automaticamente em
              </label>
              <input
                id="ate-ausencia"
                type="date"
                className={campo}
                value={prefs.autoReplyUntil ? prefs.autoReplyUntil.slice(0, 10) : ""}
                onChange={(evento) =>
                  setPrefs({
                    ...prefs,
                    autoReplyUntil: evento.target.value ? `${evento.target.value}T23:59:59.000Z` : null,
                  })
                }
              />
              {/* Sem data de volta, quem esquece de desligar avisa ausencia por meses. */}
              <p className="mt-1.5 text-xs text-[var(--color-texto-fraco)]">
                Opcional, mas recomendado: passada a data, a resposta se desliga sozinha.
              </p>
            </div>

            <p className="rounded-lg bg-[var(--color-fundo-suave)] px-3 py-2 text-xs text-[var(--color-texto-fraco)]">
              Cada remetente recebe o aviso no máximo uma vez a cada quatro dias. Listas de
              e-mail, notificações automáticas e avisos de entrega não recebem resposta.
            </p>
          </>
        )}

        <BotaoSalvar
          estado={estadoAusencia}
          onClick={() =>
            void salvar(
              {
                autoReplyEnabled: prefs.autoReplyEnabled,
                autoReplySubject: prefs.autoReplySubject,
                autoReplyBody: prefs.autoReplyBody,
                autoReplyUntil: prefs.autoReplyUntil,
              },
              "/me/settings",
              "PUT",
              setEstadoAusencia,
            )
          }
        />
      </Secao>

      <Secao titulo="Leitura">
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={prefs.showRemoteImages}
            onChange={(evento) => setPrefs({ ...prefs, showRemoteImages: evento.target.checked })}
          />
          <span>
            Exibir imagens externas automaticamente
            <span className="mt-0.5 block text-xs text-[var(--color-texto-fraco)]">
              Deixando desligado, quem envia não descobre a hora em que você abriu a mensagem.
            </span>
          </span>
        </label>

        <div>
          <label htmlFor="por-pagina" className="mb-1.5 block text-sm font-medium">
            Mensagens por página
          </label>
          <input
            id="por-pagina"
            type="number"
            min={10}
            max={100}
            className={`${campo} w-28`}
            value={prefs.messagesPerPage}
            onChange={(evento) => setPrefs({ ...prefs, messagesPerPage: Number(evento.target.value) })}
          />
        </div>

        <BotaoSalvar
          estado={estadoPrefs}
          onClick={() =>
            void salvar(
              { showRemoteImages: prefs.showRemoteImages, messagesPerPage: prefs.messagesPerPage },
              "/me/settings",
              "PUT",
              setEstadoPrefs,
            )
          }
        />
      </Secao>

      <Secao
        titulo="Avisos de mensagem nova"
        descricao="Contador na aba, balão do sistema e aviso no aparelho mesmo com o webmail fechado."
      >
        <AvisosDeMensagem />
      </Secao>

      <Secao
        titulo="Filtros"
        descricao="Quando chegar mensagem assim, faça isto — mover para pasta, marcar como lida, favoritar, encaminhar cópia."
      >
        <FiltrosCaixa />
      </Secao>

      <Secao titulo="Senha">
        <CampoSenha id="senha-atual" label="Senha atual" value={senhaAtual} onChange={setSenhaAtual} />

          <CampoSenha id="senha-nova" label="Nova senha" value={senhaNova} onChange={setSenhaNova} autoComplete="new-password" />
        <div>
          <p className="mt-1.5 text-xs text-[var(--color-texto-fraco)]">
            Mínimo de 12 caracteres. Trocar a senha encerra as sessões nos outros aparelhos.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void trocarSenha()}
            disabled={estadoSenha === "salvando" || !senhaAtual || !senhaNova}
            className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
          >
            {estadoSenha === "salvando" ? "Trocando…" : "Trocar senha"}
          </button>
          {estadoSenha === "salvo" && <span className="text-xs text-emerald-700">senha alterada</span>}
        </div>
      </Secao>

      <Secao
        titulo="Verificação em duas etapas"
        descricao="Um código do celular além da senha, para o login no webmail."
      >
        <VerificacaoDuasEtapas />
      </Secao>

      <Secao
        titulo="Trazer meus e-mails antigos"
        descricao="Copiamos as mensagens do seu provedor atual (Zoho, Titan, Gmail...) para ca."
      >
        <MigracaoCaixa endereco={endereco} />
      </Secao>

      <Secao
        titulo="Configurar no celular ou no Outlook"
        descricao="Para ler esta caixa fora do webmail — Gmail no Android, Mail no iPhone, Outlook, Thunderbird."
      >
        <ConfiguracaoDispositivos endereco={endereco} />
      </Secao>

      <Secao
        titulo="Usar no celular e no Outlook"
        descricao="Servidores, portas e o passo a passo de cada aplicativo."
      >
        <p className="text-sm text-[var(--color-texto-fraco)]">
          IMAP <code className="font-mono">mail.avilaops.com</code> porta 993 (SSL/TLS) · SMTP porta 587
          (STARTTLS) · usuário é o endereço completo.{" "}
          <a href="/configurar" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Ver o guia completo
          </a>
        </p>
      </Secao>

      <Secao
        titulo="Desenvolvedor"
        descricao="Chaves para usar sua caixa (ou a API de provisionamento) a partir de scripts, do n8n ou de outro sistema — crie, copie e revogue por aqui."
      >
        <ChavesDeApi host={typeof window === "undefined" ? "mail.avilaops.com" : window.location.hostname} />
      </Secao>

      <Secao titulo="Aparelhos conectados" descricao="Onde sua caixa está aberta agora.">
        <ul className="divide-y divide-[var(--color-borda)] rounded-lg border border-[var(--color-borda)]">
          {dispositivos.length === 0 && (
            <li className="px-3 py-3 text-sm text-[var(--color-texto-fraco)]">Nenhuma sessão ativa.</li>
          )}
          {dispositivos.map((dispositivo) => (
            <li key={dispositivo.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{dispositivo.device || "Aparelho desconhecido"}</p>
                <p className="text-xs text-[var(--color-texto-fraco)]">
                  {[dispositivo.location, dispositivo.ip].filter(Boolean).join(" · ") || "origem desconhecida"}
                </p>
                <p className="text-xs text-[var(--color-texto-fraco)]">
                  último acesso {new Date(dispositivo.lastUsedAt).toLocaleString("pt-BR")}
                </p>
              </div>
              <button
                onClick={() =>
                  void api(`/me/sessions/${dispositivo.id}`, { method: "DELETE" })
                    .then(carregarDispositivos)
                    .catch((falha: Error) => setErro(falha.message))
                }
                className="shrink-0 rounded-md border border-[var(--color-borda)] px-2.5 py-1 text-xs transition hover:bg-red-50 hover:text-[var(--color-perigo)]"
              >
                Desconectar
              </button>
            </li>
          ))}
        </ul>

        {dispositivos.length > 1 && (
          <button
            onClick={() =>
              void api("/me/sessions/revoke-all", { method: "POST" }).then(() => {
                // Derruba a sessao atual junto — e o comportamento esperado de
                // "sair de todos", entao voltamos para o login.
                window.location.href = "/entrar";
              })
            }
            className="text-xs text-[var(--color-perigo)] underline underline-offset-2"
          >
            Desconectar de todos os aparelhos
          </button>
        )}
      </Secao>
    </div>
  );
}
