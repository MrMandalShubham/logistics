import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { pool, type Claims } from "../db";
import { logger, correlationId } from "../logging";
import { COOKIE_NAME, hashToken } from "../auth/session";
import { verify } from "../webhooks";

/**
 * The wrapper every route goes through.
 *
 * Order matters, and each step is where it is for a reason:
 *
 *   1. authenticate   -- a session cookie OR a bearer key
 *   2. rate limit     -- BEFORE scope and body parsing, so a client in
 *                        a hot retry loop costs one indexed UPDATE
 *   3. authorise      -- permission (human) or scope (machine)
 *   4. parse body
 *   5. idempotency    -- replay a prior response verbatim
 *   6. run under RLS  -- claims set, role switched, one transaction
 *   7. log            -- after the response is built, never before
 *
 * ── One connection per request ──
 *
 * Inventory once used up to five (authenticate, idempotency lookup,
 * handler, record, log) and measured 3.5 seconds on its busiest
 * endpoint under load, all of it queueing. Auth and the idempotency
 * lookup run before the role switch, on the same client.
 */

export type ApiContext = {
  /**
   * The session connection: claims set, role switched, RLS applied.
   * Handlers MUST use this and never pool.connect() of their own -- a
   * fresh connection has no claims, so RLS sees an anonymous caller
   * and silently returns nothing.
   */
  db: PoolClient;
  claims: Claims;
  actorKind: "USER" | "API_CLIENT";
  clientId: string | null;
  userId: string | null;
  role: string;
  scopes: string[];
  permissions: string[];
  body: any;
  /** The exact bytes received, for anything that must not re-serialise. */
  rawBody: string;
  req: NextRequest;
  params: Record<string, string>;
  correlationId: string;
};

type Handler = (ctx: ApiContext) => Promise<{ status?: number; body: unknown }>;

type Options = {
  /** How the caller may authenticate. Default: either. */
  auth?: "session" | "key" | "either" | "public";
  /** Required permission for a human caller. */
  permission?: string;
  /** Required scope for a machine caller. */
  scope?: string;
  /** Writes get idempotency handling and require the header. */
  idempotent?: boolean;
  /**
   * Require an HMAC signature over the raw body.
   *
   * `secretEnv` names the environment variable holding the shared
   * secret; `header` the header carrying it. Verified BEFORE the
   * idempotency lookup, so a replayed key with a bad signature cannot
   * collect a cached 2xx without ever proving it knows the secret.
   */
  signature?: { secretEnv: string; header?: string };
};

const PG_ERR: Record<string, { status: number; code: string }> = {
  "42501": { status: 403, code: "forbidden" },
  "28P01": { status: 401, code: "invalid_credentials" },
  "28000": { status: 423, code: "locked_out" },
  P0002: { status: 404, code: "not_found" },
  "23505": { status: 409, code: "conflict" },
  "23514": { status: 409, code: "unprocessable" },
  "23503": { status: 422, code: "bad_reference" },
};

/** Postgres exceptions here carry a NAME: prefix. Surface it. */
function parseError(e: any) {
  const raw: string = e?.message ?? String(e);
  const named = /^([A-Z_]{3,}):\s*(.*)$/s.exec(raw);
  const mapped = PG_ERR[e?.code] ?? { status: 500, code: "internal_error" };
  return {
    status: mapped.status,
    code: named ? named[1].toLowerCase() : mapped.code,
    message: named ? named[2] : mapped.status >= 500 ? "Something went wrong." : raw,
  };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return NextResponse.json(body as any, {
    status,
    headers: { "X-Api-Version": "v1", ...extra },
  });
}

export function apiRoute(opts: Options, handler: Handler) {
  return async function route(
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ) {
    const started = Date.now();
    const path = new URL(req.url).pathname;
    const cid = correlationId(req);
    const auth = opts.auth ?? "either";

    let db: PoolClient | null = null;
    let limitHeaders: Record<string, string> = {};

    const finish = (res: NextResponse, extra: Record<string, unknown> = {}) => {
      res.headers.set("X-Correlation-Id", cid);
      logger.info("request", {
        method: req.method, path, status: res.status,
        ms: Date.now() - started, correlation_id: cid, ...extra,
      });
      return res;
    };

    try {
      const params = context?.params ? await context.params : {};
      db = await pool.connect();

      // ── 1. Authenticate ──
      let claims: Claims | null = null;

      const bearer = req.headers.get("authorization") ?? "";
      const key = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
      const cookie = req.cookies.get(COOKIE_NAME)?.value ?? null;

      if (key && auth !== "session") {
        const { rows } = await db.query(
          "select integration.authenticate_api_key($1) as claims", [key]);
        claims = rows[0]?.claims ?? null;
      } else if (cookie && auth !== "key") {
        const { rows } = await db.query(
          "select identity.resolve_session($1) as claims", [hashToken(cookie)]);
        claims = rows[0]?.claims ?? null;
      }

      if (auth === "public") {
        claims = claims ?? { role: "anon", actor_kind: "ANON", location_codes: [] };
      }

      if (!claims) {
        return finish(json(401, {
          error: {
            code: "unauthorized",
            message: key
              ? "That key is not valid."
              : "Sign in, or send a key as: Authorization: Bearer lg_live_...",
          },
        }));
      }

      claims.correlation_id = cid;

      const actorKind = String(claims.actor_kind ?? "USER") as ApiContext["actorKind"];
      const role = String(claims.role ?? "anon");
      const clientId = claims.client_id ? String(claims.client_id) : null;
      const userId = claims.sub ? String(claims.sub) : null;
      const scopes = (claims.scopes as string[]) ?? [];
      const permissions = (claims.permissions as string[]) ?? [];

      // ── 2. Rate limit (machine callers) ──
      if (clientId) {
        const { rows: [rl] } = await db.query(
          "select * from integration.consume_rate_token($1, 1)", [clientId]);

        // On every response, not only a 429. A limit a client can only
        // discover by hitting it is a limit they will hit.
        limitHeaders = {
          "X-RateLimit-Limit": String(rl.limit_per_min),
          "X-RateLimit-Remaining": String(Math.max(0, rl.remaining ?? 0)),
        };

        if (!rl.allowed) {
          return finish(json(429, {
            error: {
              code: "rate_limited",
              message: `This key is limited to ${rl.limit_per_min} requests a minute. ` +
                       `Retry in ${rl.retry_after}s.`,
              retry_after: rl.retry_after,
            },
          }, { ...limitHeaders, "Retry-After": String(rl.retry_after) }),
          { rate_limited: true });
        }
      }

      // ── 3. Authorise ──
      //
      // A password that must be changed blocks everything else. An
      // account handed over with a temporary password should not be
      // able to do work under it.
      if (claims.must_change_password && !path.endsWith("/auth/password")) {
        return finish(json(403, {
          error: {
            code: "password_change_required",
            message: "Set a new password before using the system.",
          },
        }));
      }

      if (opts.permission && actorKind === "USER" && !permissions.includes(opts.permission)) {
        return finish(json(403, {
          error: {
            code: "forbidden",
            message: `Your role (${role}) does not hold "${opts.permission}".`,
            required: opts.permission,
          },
        }));
      }

      if (opts.scope && actorKind === "API_CLIENT"
          && !scopes.includes(opts.scope) && !scopes.includes("*")) {
        return finish(json(403, {
          error: {
            code: "insufficient_scope",
            message: `This key does not hold the "${opts.scope}" scope.`,
            required: opts.scope, granted: scopes,
          },
        }));
      }

      // ── 4. Body, and its signature ──
      let body: any = null;
      let rawBody = "";

      if (req.method !== "GET" && req.method !== "DELETE") {
        rawBody = await req.text();

        // The signature covers the RAW bytes. Verifying a re-serialised
        // object would compare a MAC against something the sender never
        // signed, and would fail on nothing more than key ordering.
        if (opts.signature) {
          const secret = process.env[opts.signature.secretEnv];
          if (!secret) {
            logger.error("signature secret not configured", {
              env: opts.signature.secretEnv, path,
            });
            return finish(json(500, {
              error: {
                code: "signing_not_configured",
                message: "This endpoint requires a shared secret that is not set.",
              },
            }, limitHeaders));
          }

          const header = req.headers.get(
            opts.signature.header ?? "x-logistics-signature");
          const result = verify(secret, rawBody, header);

          if (!result.ok) {
            logger.warn("signature rejected", { path, reason: result.reason, correlation_id: cid });
            return finish(json(401, {
              error: { code: "invalid_signature", message: result.reason },
            }, limitHeaders));
          }
        }

        if (rawBody) {
          try { body = JSON.parse(rawBody); }
          catch {
            return finish(json(400, {
              error: { code: "invalid_json", message: "The request body is not valid JSON." },
            }, limitHeaders));
          }
        }
      }

      // ── 5. Idempotency ──
      //
      // Required on writes, not optional. A network timeout is
      // indistinguishable from a failure, so clients retry; without a
      // key the retry does the work twice.
      let idemKey: string | null = null;
      let idemHash: string | null = null;

      if (opts.idempotent && clientId) {
        idemKey = req.headers.get("idempotency-key");
        if (!idemKey) {
          return finish(json(400, {
            error: {
              code: "idempotency_key_required",
              message: "Writes require an Idempotency-Key header. Reuse it when you retry.",
            },
          }, limitHeaders));
        }

        idemHash = createHash("sha256")
          .update(`${req.method}\n${path}\n${JSON.stringify(body ?? null)}`)
          .digest("hex");

        const prior = (await db.query(
          `select request_hash, status_code, response_body
             from integration.idempotency_record
            where api_client_id = $1 and key = $2`, [clientId, idemKey])).rows[0];

        if (prior) {
          if (prior.request_hash !== idemHash) {
            return finish(json(422, {
              error: {
                code: "idempotency_key_reused",
                message: "That Idempotency-Key was already used for a different request.",
              },
            }, limitHeaders));
          }
          return finish(
            json(prior.status_code, prior.response_body,
                 { ...limitHeaders, "Idempotent-Replay": "true" }),
            { replayed: true });
        }
      }

      // ── 6. Run it, under RLS, on the same connection ──
      let result: { status?: number; body: unknown };
      try {
        await db.query("begin");
        await db.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify(claims)]);
        await db.query("set local role authenticated");

        result = await handler({
          db, claims, actorKind, clientId, userId, role, scopes, permissions,
          body, rawBody, req, params, correlationId: cid,
        });

        await db.query("commit");
      } catch (inner) {
        await db.query("rollback").catch(() => {});
        throw inner;
      }

      const outStatus = result.status ?? 200;
      const outBody = { ...(result.body as object), as_of: new Date().toISOString() };

      if (idemKey && clientId) {
        await db.query(
          `insert into integration.idempotency_record
             (api_client_id, key, method, path, request_hash, status_code, response_body)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (api_client_id, key) do nothing`,
          [clientId, idemKey, req.method, path, idemHash, outStatus, outBody]);
      }

      return finish(json(outStatus, outBody, limitHeaders));
    } catch (e: any) {
      const err = parseError(e);
      if (err.status >= 500) {
        logger.error("unhandled", { path, err: e?.message, correlation_id: cid });
      }
      return finish(json(err.status,
        { error: { code: err.code, message: err.message } }, limitHeaders));
    } finally {
      db?.release();
    }
  };
}
