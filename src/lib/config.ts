/**
 * Configuracao central do avila-mail.
 *
 * Tudo vem de variavel de ambiente e e validado na subida: um servidor de
 * e-mail que sobe com config pela metade entrega mal e some com mensagem.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Variavel de ambiente ${name} deve ser um numero inteiro`);
  }
  return parsed;
}

export type RelayDriver = "direct" | "smtp" | "n8n";

/**
 * Padrao `direct` desde 14/08/2026, quando a Hetzner liberou a porta 25 de
 * saida. As pontes (`smtp`, `n8n`) continuam no codigo como contingencia — se
 * um dia o IP entrar em bloqueio de reputacao, trocar a variavel e reiniciar
 * devolve a saida sem tocar em codigo.
 */
function relayDriver(): RelayDriver {
  const raw = optional("MAIL_RELAY_DRIVER", "direct");
  if (raw !== "direct" && raw !== "smtp" && raw !== "n8n") {
    throw new Error(`MAIL_RELAY_DRIVER invalido: ${raw}. Use direct, smtp ou n8n.`);
  }
  return raw;
}

export const config = {
  hostname: optional("MAIL_HOSTNAME", "mail.avilaops.com"),
  storageDir: optional("MAIL_STORAGE_DIR", "/var/lib/avila-mail/blobs"),

  ports: {
    inbound: int("MAIL_INBOUND_PORT", 25),
    submission: int("MAIL_SUBMISSION_PORT", 587),
    submissionTls: int("MAIL_SUBMISSION_TLS_PORT", 465),
    pop3: int("MAIL_POP3_PORT", 110),
    pop3Tls: int("MAIL_POP3_TLS_PORT", 995),
    imap: int("MAIL_IMAP_PORT", 143),
    imapTls: int("MAIL_IMAP_TLS_PORT", 993),
  },

  tls: {
    certPath: optional("MAIL_TLS_CERT_PATH"),
    keyPath: optional("MAIL_TLS_KEY_PATH"),
  },

  api: {
    port: int("MAIL_API_PORT", 3040),
    bind: optional("MAIL_API_BIND", "127.0.0.1"),
    token: optional("MAIL_API_TOKEN"),
  },

  relay: {
    driver: relayDriver(),
    smtp: {
      host: optional("MAIL_RELAY_SMTP_HOST"),
      port: int("MAIL_RELAY_SMTP_PORT", 587),
      user: optional("MAIL_RELAY_SMTP_USER"),
      pass: optional("MAIL_RELAY_SMTP_PASS"),
    },
    n8n: {
      url: optional("MAIL_RELAY_N8N_URL"),
      token: optional("MAIL_RELAY_N8N_TOKEN"),
    },
  },

  dkim: {
    encryptionKey: optional("MAIL_DKIM_ENCRYPTION_KEY"),
  },

  /**
   * Cloudflare, usado para publicar sozinho o TXT do DKIM de cada dominio
   * novo na NOSSA zona (alvo do CNAME que o cliente publica na zona dele).
   *
   * Sem isso o dominio nasce com o CNAME apontando para um alvo vazio: o
   * cliente publica os tres registros que a API devolve, tudo parece certo, e
   * o e-mail cai em spam com "dkim=neutral (no key)". Ja aconteceu com o
   * despolarizamed.com.br em 31/08/2026.
   *
   * Vazio = a publicacao nao acontece e o registro fica so no retorno da API,
   * para alguem publicar a mao.
   */
  cloudflare: {
    email: optional("CLOUDFLARE_EMAIL"),
    // A Global Key e nao um token com escopo: os tokens da casa nao tem
    // permissao de DNS (ver docs). Ela vive no tokens.env do servidor.
    globalKey: optional("CLOUDFLARE_API_GLOBAL_KEY"),
    /** Zona onde ficam os alvos *.dkim.<zona raiz>. */
    zoneId: optional("CLOUDFLARE_ZONE_ID"),
  },

  /**
   * Aquecimento de IP na saida direta. `inicio` vazio = sem rampa.
   * Cada valor de `capsSemanais` e o teto DIARIO de mensagens externas
   * durante uma semana; terminada a lista, o aquecimento acabou.
   */
  warmup: {
    inicio: optional("MAIL_WARMUP_INICIO"),
    capsSemanais: optional("MAIL_WARMUP_CAPS", "30,60,120,250,500,1000")
      .split(",")
      .map((valor) => Number.parseInt(valor.trim(), 10)),
  },

  billing: {
    accessToken: optional("MP_ACCESS_TOKEN"),
    webhookSecret: optional("MP_WEBHOOK_SECRET"),
    /**
     * Para onde o Mercado Pago devolve o cliente depois do cartao.
     *
     * SEM valor padrao de proposito. Um dominio embutido aqui sobrevive a
     * mudanca de marca e a troca de portal sem ninguem perceber — e o erro so
     * aparece quando um cliente pagante cai numa pagina morta. Melhor falhar
     * na subida do que silenciosamente mandar gente para o lugar errado.
     */
    backUrl: optional("MP_BACK_URL"),
    unitPriceCents: int("MAIL_PRECO_CAIXA_CENTAVOS", 1000),
    /** Dias de tolerancia apos a primeira recusa antes de suspender o acesso. */
    graceDays: int("MAIL_DIAS_TOLERANCIA", 5),
  },

  /**
   * Cadastro self-service (`/v1/public/signup/*`).
   *
   * Caixa de e-mail e alvo classico de quem quer disparar spam, e a reputacao
   * do nosso IP e compartilhada por todos os clientes da casa: um spammer
   * novo joga no lixo o e-mail de quem ja esta aqui. Por isso a abertura ao
   * publico e uma decisao explicita, e nao o padrao.
   */
  signup: {
    /**
     * `restrito` = so quem ja e cliente da casa fecha compra sozinho (o
     * e-mail do pagador precisa ser conhecido). `aberto` = qualquer um.
     * Comeca restrito por decisao do Nicolas em 01/09/2026: primeiro roda com
     * cliente conhecido, depois abre.
     */
    modo: optional("MAIL_SIGNUP_MODO", "restrito"),
    /** Teto de caixas num cadastro novo. Compra maior passa por gente. */
    maxCaixas: int("MAIL_SIGNUP_MAX_CAIXAS", 5),
    /** Envio por hora enquanto a caixa e novata. O padrao normal e 200. */
    limiteEnvioNovato: int("MAIL_SIGNUP_LIMITE_ENVIO_NOVATO", 20),
    /** Dias com o freio de novato ligado. */
    diasNovato: int("MAIL_SIGNUP_DIAS_NOVATO", 7),
    /**
     * Idade minima do dominio, em dias. Dominio registrado ontem e o padrao
     * de quem queima um por campanha. Consultado por RDAP; se o RDAP nao
     * responder, deixamos passar e registramos, porque recusar cliente de
     * verdade por indisponibilidade de terceiro e pior.
     */
    idadeMinimaDias: int("MAIL_SIGNUP_IDADE_MINIMA_DIAS", 30),
    /**
     * Para onde o Mercado Pago devolve quem comprou pelo autoatendimento.
     *
     * Separado do `MP_BACK_URL` de proposito: aquele aponta para a area do
     * cliente, que exige login, e quem acabou de comprar sozinho ainda nao
     * tem conta. Mandar essa pessoa para uma tela de login e perde-la
     * justamente depois de ela ter pago.
     */
    retornoUrl: optional("MAIL_SIGNUP_BACK_URL"),
    /** Horas que um pedido nao pago fica de pe antes de expirar. */
    horasParaExpirar: int("MAIL_SIGNUP_HORAS_EXPIRAR", 48),
  },

  /**
   * Quem pode criar chave de API de provisionamento pela area de desenvolvedor.
   * Endereco da caixa OU e-mail do dono no SSO, separados por virgula.
   */
  /**
   * Web Push (aviso com a aba fechada). Sem as chaves, o recurso simplesmente
   * nao existe — o webmail nao oferece o botao e a entrega segue igual.
   */
  /** Fuso da operacao: e nele que o silencio noturno do cliente e interpretado. */
  timezone: optional("MAIL_TIMEZONE", "America/Sao_Paulo"),

  push: {
    publicKey: optional("MAIL_VAPID_PUBLIC_KEY"),
    privateKey: optional("MAIL_VAPID_PRIVATE_KEY"),
    /** Contato exigido pelo protocolo: quem os servicos de push acionam se algo der errado. */
    subject: optional("MAIL_VAPID_SUBJECT", "mailto:suporte@avilaops.com"),
  },

  admin: {
    addresses: optional("MAIL_ADMIN_ADDRESSES", "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0),
  },

  session: {
    jwtSecret: optional("MAIL_JWT_SECRET"),
    accessTokenMinutes: int("MAIL_ACCESS_TOKEN_MINUTES", 15),
    refreshTokenDays: int("MAIL_REFRESH_TOKEN_DAYS", 30),
    maxLoginFailures: int("MAIL_LOGIN_MAX_FAILURES", 8),
  },

  limits: {
    maxMessageBytes: int("MAIL_MAX_MESSAGE_BYTES", 26_214_400),
    defaultQuotaBytes: int("MAIL_DEFAULT_QUOTA_GB", 5) * 1024 * 1024 * 1024,
    defaultSendLimitPerHour: int("MAIL_DEFAULT_SEND_LIMIT_PER_HOUR", 200),
    maxDeliveryAttempts: int("MAIL_MAX_DELIVERY_ATTEMPTS", 12),
  },
} as const;

/**
 * Falha cedo e alto: chamado na subida de cada processo.
 * Cada checagem aqui corresponde a um modo de falha silenciosa em producao.
 */
export function assertConfig(scope: "mta" | "api"): void {
  required("MAIL_DATABASE_URL");

  if (!config.dkim.encryptionKey || config.dkim.encryptionKey.length !== 64) {
    throw new Error(
      "MAIL_DKIM_ENCRYPTION_KEY deve ter 32 bytes em hex (64 caracteres). Gere com: openssl rand -hex 32",
    );
  }

  if (scope === "api") {
    if (!config.api.token) {
      throw new Error("MAIL_API_TOKEN e obrigatorio: a API de provisionamento nao sobe sem autenticacao.");
    }
    if (config.session.jwtSecret.length < 32) {
      throw new Error(
        "MAIL_JWT_SECRET deve ter no minimo 32 caracteres. Gere com: openssl rand -hex 48",
      );
    }
  }

  if (config.warmup.inicio && !/^\d{4}-\d{2}-\d{2}$/.test(config.warmup.inicio)) {
    throw new Error(`MAIL_WARMUP_INICIO deve ser uma data YYYY-MM-DD, recebi: ${config.warmup.inicio}`);
  }
  if (config.warmup.capsSemanais.some((cap) => !Number.isFinite(cap) || cap <= 0)) {
    throw new Error("MAIL_WARMUP_CAPS deve ser uma lista de inteiros positivos separados por virgula.");
  }

  if (scope === "mta") {
    if (config.relay.driver === "smtp" && !config.relay.smtp.host) {
      throw new Error("MAIL_RELAY_DRIVER=smtp exige MAIL_RELAY_SMTP_HOST.");
    }
    if (config.relay.driver === "n8n" && !config.relay.n8n.url) {
      throw new Error("MAIL_RELAY_DRIVER=n8n exige MAIL_RELAY_N8N_URL.");
    }
  }
}
