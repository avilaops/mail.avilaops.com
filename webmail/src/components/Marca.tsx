/**
 * Marca da Ávila Ops nas telas de entrada (login, 2FA, escolha de caixa,
 * primeira senha).
 *
 * Usa o mesmo ícone que o celular mostra ao instalar o webmail como app: quem
 * chegou pelo atalho reconhece a marca antes de ler o título. Antes havia aqui
 * um quadrado preto de reserva, que nunca foi trocado.
 */
export function Marca({ legenda = "Ávila Mail" }: { legenda?: string }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- ícone estático, sem otimização */}
      <img
        src="/web-app-manifest-192x192.png"
        alt=""
        width={40}
        height={40}
        className="h-10 w-10 rounded-xl shadow-sm"
      />
      <span className="text-sm font-semibold tracking-tight text-[var(--color-tinta)]">{legenda}</span>
    </div>
  );
}
