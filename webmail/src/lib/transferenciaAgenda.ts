const LIMITE_ARQUIVO = 50 * 1024 * 1024;
const LIMITE_EVENTOS = 10_000;
const LIMITE_EVENTO = 512 * 1024;

export async function validarArquivoIcs(arquivo: Pick<File, "name" | "size" | "text">): Promise<string | null> {
  if (arquivo.size > LIMITE_ARQUIVO) return "O arquivo .ics não pode exceder 50 MB.";
  if (!arquivo.name.toLowerCase().endsWith(".ics")) return "Selecione um arquivo com extensão .ics.";

  const texto = await arquivo.text();
  const eventos = texto.match(/BEGIN:VEVENT\r?\n[\s\S]*?\r?\nEND:VEVENT/gi) ?? [];
  if (eventos.length === 0) return "O arquivo não contém eventos.";
  if (eventos.length > LIMITE_EVENTOS) return "O arquivo não pode conter mais de 10 mil eventos.";
  if (eventos.some((evento) => new TextEncoder().encode(evento).byteLength > LIMITE_EVENTO)) {
    return "Cada evento do arquivo deve ter no máximo 512 KB.";
  }
  return null;
}
