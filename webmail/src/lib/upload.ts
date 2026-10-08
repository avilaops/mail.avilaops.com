"use client";

/**
 * Envio de anexo com barra de progresso.
 *
 * Usa XMLHttpRequest porque `fetch` nao reporta progresso de UPLOAD — so de
 * download. Anexo de 20 MB sem barra deixa o cliente olhando para uma tela
 * parada sem saber se travou.
 *
 * O arquivo sobe antes da mensagem: assim cada anexo tem seu proprio
 * progresso, da para cancelar um sem perder o texto, e o "enviar" no fim e
 * instantaneo.
 */

export interface AnexoEnviado {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

function tokenCsrf(): string {
  const encontrado = document.cookie
    .split(";")
    .map((parte) => parte.trim())
    .find((parte) => parte.startsWith("avila_mail_csrf="));

  return encontrado ? decodeURIComponent(encontrado.slice("avila_mail_csrf=".length)) : "";
}

function lerComoBase64(arquivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
    leitor.onload = () => {
      const resultado = String(leitor.result);
      // readAsDataURL devolve "data:<tipo>;base64,<conteudo>".
      const virgula = resultado.indexOf(",");
      resolve(virgula === -1 ? "" : resultado.slice(virgula + 1));
    };
    leitor.readAsDataURL(arquivo);
  });
}

export function enviarAnexo(
  arquivo: File,
  aoProgredir: (percentual: number) => void,
): { promessa: Promise<AnexoEnviado>; cancelar: () => void } {
  const requisicao = new XMLHttpRequest();

  const promessa = (async () => {
    const conteudo = await lerComoBase64(arquivo);

    return new Promise<AnexoEnviado>((resolve, reject) => {
      requisicao.open("POST", "/api/mail/me/attachments");
      requisicao.setRequestHeader("Content-Type", "application/json");
      requisicao.setRequestHeader("x-csrf-token", tokenCsrf());
      requisicao.withCredentials = true;

      requisicao.upload.onprogress = (evento) => {
        if (evento.lengthComputable) {
          aoProgredir(Math.round((evento.loaded / evento.total) * 100));
        }
      };

      requisicao.onload = () => {
        let corpo: unknown = null;
        try {
          corpo = JSON.parse(requisicao.responseText);
        } catch {
          corpo = null;
        }

        if (requisicao.status >= 200 && requisicao.status < 300) {
          aoProgredir(100);
          resolve(corpo as AnexoEnviado);
          return;
        }

        const mensagem =
          corpo && typeof corpo === "object" && "erro" in corpo
            ? String((corpo as { erro?: unknown }).erro)
            : "Falha ao enviar o anexo.";
        reject(new Error(mensagem));
      };

      requisicao.onerror = () => reject(new Error("Sem conexao ao enviar o anexo."));
      requisicao.onabort = () => reject(new Error("cancelado"));

      requisicao.send(
        JSON.stringify({
          filename: arquivo.name,
          contentType: arquivo.type || "application/octet-stream",
          contentBase64: conteudo,
        }),
      );
    });
  })();

  return { promessa, cancelar: () => requisicao.abort() };
}

export function formatarTamanho(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
