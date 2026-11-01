/**
 * O Next aguarda as respostas abertas antes de encerrar o servidor HTTP.
 * SSE e deliberadamente longo: precisa liberar a conexao quando chega o
 * sinal de parada, enquanto o Next continua drenando as demais requisicoes.
 */
export function sinalDeEncerramento(): AbortSignal {
  const estado = globalThis as typeof globalThis & { mailEncerramento?: AbortController };
  if (!estado.mailEncerramento) {
    const controle = new AbortController();
    estado.mailEncerramento = controle;
    const encerrar = () => controle.abort();
    // Um par de handlers por processo, nunca um par por conexao/caixa.
    process.once("SIGTERM", encerrar);
    process.once("SIGINT", encerrar);
  }
  return estado.mailEncerramento.signal;
}

/** Converte cancelamento esperado em EOF; falhas reais continuam sendo erros. */
export function fluxoCancelavel(corpo: ReadableStream<Uint8Array>, sinal: AbortSignal): ReadableStream<Uint8Array> {
  const leitor = corpo.getReader();
  let encerrado = false;
  return new ReadableStream<Uint8Array>({
    async pull(destino) {
      try {
        const { done, value } = await leitor.read();
        if (encerrado) return;
        if (done) {
          encerrado = true;
          destino.close();
        }
        else destino.enqueue(value);
      } catch (erro) {
        if (encerrado) return;
        encerrado = true;
        if (sinal.aborted) destino.close();
        else destino.error(erro);
      }
    },
    cancel(motivo) {
      encerrado = true;
      return leitor.cancel(motivo);
    },
  });
}
