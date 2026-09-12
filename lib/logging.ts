import { randomUUID } from "node:crypto";

/**
 * Structured logging with redaction.
 *
 * The redactor is built now, in the phase that holds nothing but
 * staff email addresses, so that Phase 2's customer names, phone
 * numbers and street addresses land in a logger that is already
 * safe. Adding redaction after the data arrives means auditing every
 * log line ever written.
 */

const SECRET_KEYS = [
  "authorization", "cookie", "set-cookie", "password", "password_hash",
  "token", "token_hash", "api_key", "apikey", "key", "key_hash",
  "secret", "signature", "x-logistics-signature", "x-inventory-signature",
  "service_role_key", "anon_key", "otp", "otp_hash",
];

/** Fields that are personal rather than secret. Masked, not removed. */
const PII_KEYS = ["phone", "email", "recipient_name", "address_line1", "address_line2", "lat", "lng"];

function maskValue(v: unknown): string {
  const s = String(v);
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6 || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input !== "object") return input;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.includes(key)) out[k] = "[redacted]";
    else if (PII_KEYS.includes(key)) out[k] = maskValue(v);
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < MIN) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(redact(fields) as Record<string, unknown>),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => log("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => log("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => log("error", m, f),
};

/**
 * The correlation id ties one customer's order to every log line it
 * touches, across logistics, Grocery and Inventory. Accept one if the
 * caller sent it; make one if not.
 */
export function correlationId(req: Request): string {
  return (
    req.headers.get("x-correlation-id") ??
    req.headers.get("x-request-id") ??
    randomUUID()
  );
}
