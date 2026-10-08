/**
 * Log estruturado em JSON, uma linha por evento.
 * Formato pensado para ser consumido pelo Loki/Grafana que ja roda no VPS.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.MAIL_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

/** Chaves cujo valor nunca deve aparecer no log. */
const REDACTED = new Set(["password", "senha", "pass", "token", "authorization", "dkimprivatekey"]);

function sanitize(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? "[redigido]" : value;
  }
  return out;
}

function emit(level: Level, service: string, message: string, context: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service,
    message,
    ...sanitize(context),
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(service: string) {
  return {
    debug: (message: string, context: Record<string, unknown> = {}) => emit("debug", service, message, context),
    info: (message: string, context: Record<string, unknown> = {}) => emit("info", service, message, context),
    warn: (message: string, context: Record<string, unknown> = {}) => emit("warn", service, message, context),
    error: (message: string, context: Record<string, unknown> = {}) => emit("error", service, message, context),
  };
}

export type Logger = ReturnType<typeof createLogger>;
