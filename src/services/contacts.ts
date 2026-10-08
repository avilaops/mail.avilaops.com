import { prisma } from "../lib/db.js";

/**
 * Contatos e enderecos de envio.
 *
 * Nao existe agenda separada de proposito: a agenda util de uma caixa de
 * e-mail e o historico dela. Quem voce mais escreve e de quem voce mais
 * recebe sobe primeiro, sem o cliente precisar cadastrar nada.
 */

export interface Contact {
  address: string;
  name: string | null;
  frequency: number;
  lastSeen: Date;
}

interface LinhaBruta {
  address: string;
  name: string | null;
  frequency: bigint;
  last_seen: Date;
}

/**
 * Autocompletar destinatario.
 *
 * Junta remetentes das mensagens recebidas com destinatarios das enviadas.
 * O `to_addresses` e um array JSON, por isso o LATERAL — sem ele so daria para
 * olhar o primeiro destinatario de cada mensagem.
 */
export async function searchContacts(mailboxId: string, query: string, limit = 20): Promise<Contact[]> {
  const termo = `%${query.trim()}%`;
  const teto = Math.min(Math.max(limit, 1), 50);

  const linhas = await prisma.$queryRaw<LinhaBruta[]>`
    SELECT
      lower(s.addr)                      AS address,
      max(nullif(trim(s.nm), ''))        AS name,
      count(*)                           AS frequency,
      max(s.received_at)                 AS last_seen
    FROM (
      SELECT m.from_address AS addr, m.from_name AS nm, m.received_at
      FROM mail_messages m
      WHERE m.mailbox_id = ${mailboxId} AND m.from_address <> ''

      UNION ALL

      SELECT e->>'address', e->>'name', m.received_at
      FROM mail_messages m,
           LATERAL jsonb_array_elements(m.to_addresses) AS e
      WHERE m.mailbox_id = ${mailboxId}
    ) s
    WHERE s.addr IS NOT NULL
      AND s.addr <> ''
      AND (s.addr ILIKE ${termo} OR coalesce(s.nm, '') ILIKE ${termo})
    GROUP BY lower(s.addr)
    ORDER BY count(*) DESC, max(s.received_at) DESC
    LIMIT ${teto}
  `;

  return linhas.map((linha) => ({
    address: linha.address,
    name: linha.name,
    // count() do Postgres volta bigint; o JSON da API nao pode carregar isso cru.
    frequency: Number(linha.frequency),
    lastSeen: linha.last_seen,
  }));
}

export interface SendAsAddress {
  address: string;
  name: string | null;
  primary: boolean;
}

/**
 * Enderecos que a caixa pode usar como remetente: o proprio e os aliases
 * apontados para ela. Alimenta o seletor "enviar como" do webmail e e a mesma
 * lista que o envio valida — origem unica evita o painel oferecer um endereco
 * que o servidor recusa.
 */
export async function listSendAs(mailboxId: string): Promise<SendAsAddress[]> {
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, displayName: true, domainId: true, domain: { select: { name: true } } },
  });
  if (!mailbox) return [];

  const proprio = `${mailbox.localPart}@${mailbox.domain.name}`;

  const aliases = await prisma.mailAlias.findMany({
    where: { domainId: mailbox.domainId, destination: proprio },
    select: { localPart: true },
    orderBy: { localPart: "asc" },
  });

  return [
    { address: proprio, name: mailbox.displayName, primary: true },
    ...aliases.map((alias) => ({
      address: `${alias.localPart}@${mailbox.domain.name}`,
      name: mailbox.displayName,
      primary: false,
    })),
  ];
}

/** Confere se a caixa pode assinar como este endereco. */
export async function canSendAs(mailboxId: string, address: string): Promise<boolean> {
  const permitidos = await listSendAs(mailboxId);
  return permitidos.some((item) => item.address === address.trim().toLowerCase());
}
