interface D1Database {
  prepare(sql: string): D1Statement;
}
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface R2Bucket {
  put(
    key: string,
    value: string | ReadableStream | null,
    options?: unknown,
  ): Promise<unknown>;
  get(key: string): Promise<any>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  APP_ORIGIN: string;
  REVENUECAT_WEBHOOK_SECRET?: string;
  REVENUECAT_API_KEY?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  AI_MODEL?: string;
}
type User = { id: string; email: string; role?: string };
const apiError = (code: string, message: string) => ({
  error: { code, message },
});
const json = (data: unknown, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    },
  });
const id = () => crypto.randomUUID();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function digest(value: string) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
async function passwordHash(
  password: string,
  salt: string = crypto.randomUUID(),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 120000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2$${salt}$${hex(bits)}`;
}
async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "pbkdf2")
    return encoded === (await passwordHash(password, "legacy"));
  return encoded === (await passwordHash(password, parts[1]));
}
function bearerToken(request: Request) {
  const value = request.headers.get("authorization");
  return value?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}
async function auth(request: Request, env: Env): Promise<User | null> {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?")
    .bind(Date.now())
    .run();
  const token = bearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(await digest(token), Date.now())
    .first<User>();
  return row ?? null;
}
function validEmail(email: unknown) {
  return typeof email === "string" && /^\S+@\S+\.\S+$/.test(email);
}
function entitlementActive(status: string, expiresAt: number | null) {
  return (
    (status === "active" || status === "trialing") &&
    (expiresAt === null || expiresAt > Date.now())
  );
}
async function hasPremium(env: Env, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT status,expires_at FROM entitlements WHERE user_id=? AND entitlement='premium'",
  )
    .bind(userId)
    .all<any>();
  return rows.results.some((row) =>
    entitlementActive(row.status, row.expires_at),
  );
}
async function refreshRevenueCat(env: Env, user: User) {
  if (!env.REVENUECAT_API_KEY) return false;
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(user.id)}`,
    {
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) throw new Error(`RevenueCat API ${response.status}`);
  const body = (await response.json()) as any;
  const entitlements = body?.subscriber?.entitlements || {};
  const now = Date.now();
  for (const [name, value] of Object.entries(entitlements) as [string, any][]) {
    const expiresAt = value.expires_date
      ? Date.parse(value.expires_date)
      : null;
    await env.DB.prepare(
      `INSERT INTO entitlements
      (id,user_id,platform,product_id,transaction_id,original_transaction_id,entitlement,status,expires_at,environment,raw_event,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,entitlement,original_transaction_id) DO UPDATE SET
        product_id=excluded.product_id,status=excluded.status,expires_at=excluded.expires_at,
        raw_event=excluded.raw_event,updated_at=excluded.updated_at`,
    )
      .bind(
        id(),
        user.id,
        value.store || "revenuecat",
        value.product_identifier || "unknown",
        null,
        `${user.id}:${name}`,
        name,
        expiresAt && expiresAt > now ? "active" : "revoked",
        expiresAt,
        value.store || null,
        JSON.stringify(value),
        now,
        now,
      )
      .run();
  }
  return await hasPremium(env, user.id);
}
const PRODUCTS = [
  {
    id: "premium_monthly",
    entitlement: "premium",
    kind: "subscription",
    period: "monthly",
  },
  {
    id: "premium_yearly",
    entitlement: "premium",
    kind: "subscription",
    period: "yearly",
  },
  {
    id: "premium_lifetime",
    entitlement: "premium",
    kind: "lifetime",
    period: null,
  },
];
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.APP_ORIGIN || "*";
    if (request.method === "OPTIONS") return json({}, 204, origin);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health")
        return json({ ok: true, service: "huehaven-api" }, 200, origin);
      if (url.pathname === "/v1/auth/register" && request.method === "POST") {
        const b = (await request.json()) as any;
        if (
          !validEmail(b.email) ||
          typeof b.password !== "string" ||
          b.password.length < 8
        )
          return json(
            apiError("INVALID_CREDENTIALS", "邮箱或密码无效"),
            400,
            origin,
          );
        const userId = id();
        try {
          await env.DB.prepare("INSERT INTO users VALUES (?,?,?,?)")
            .bind(
              userId,
              b.email.toLowerCase(),
              await passwordHash(b.password),
              Date.now(),
            )
            .run();
        } catch {
          return json(apiError("EMAIL_EXISTS", "邮箱已注册"), 409, origin);
        }
        const token = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO sessions VALUES (?,?,?,?)")
          .bind(
            await digest(token),
            userId,
            Date.now() + 30 * 86400000,
            Date.now(),
          )
          .run();
        return json(
          { token, user: { id: userId, email: b.email.toLowerCase() } },
          201,
          origin,
        );
      }
      if (url.pathname === "/v1/auth/login" && request.method === "POST") {
        const b = (await request.json()) as any;
        const email = typeof b.email === "string" ? b.email.toLowerCase() : "";
        if (
          !validEmail(email) ||
          typeof b.password !== "string" ||
          b.password.length < 8
        )
          return json(
            apiError("INVALID_CREDENTIALS", "邮箱或密码错误"),
            401,
            origin,
          );
        const now = Date.now();
        const attempt = await env.DB.prepare(
          "SELECT failed_count,window_started_at,blocked_until FROM login_attempts WHERE email=?",
        )
          .bind(email)
          .first<any>();
        if (attempt?.blocked_until > now)
          return json(
            apiError("RATE_LIMITED", "登录失败次数过多，请稍后再试"),
            429,
            origin,
          );
        const u = await env.DB.prepare(
          "SELECT id,email,password_hash FROM users WHERE email=?",
        )
          .bind(email)
          .first<any>();
        if (!u || !(await verifyPassword(b.password, u.password_hash))) {
          const count =
            attempt && now - attempt.window_started_at < 15 * 60 * 1000
              ? attempt.failed_count + 1
              : 1;
          const blocked = count >= 5 ? now + 15 * 60 * 1000 : 0;
          await env.DB.prepare(
            "INSERT OR REPLACE INTO login_attempts (email,failed_count,window_started_at,blocked_until) VALUES (?,?,?,?)",
          )
            .bind(
              email,
              count,
              attempt && now - attempt.window_started_at < 15 * 60 * 1000
                ? attempt.window_started_at
                : now,
              blocked,
            )
            .run();
          return json(
            apiError("INVALID_CREDENTIALS", "邮箱或密码错误"),
            401,
            origin,
          );
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE email=?")
          .bind(email)
          .run();
        const token = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO sessions VALUES (?,?,?,?)")
          .bind(await digest(token), u.id, now + 30 * 86400000, now)
          .run();
        return json({ token, user: { id: u.id, email: u.email } }, 200, origin);
      }
      if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
        const token = bearerToken(request);
        if (token)
          await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
            .bind(await digest(token))
            .run();
        return json({ ok: true }, 200, origin);
      }
      if (
        url.pathname === "/v1/webhooks/revenuecat" &&
        request.method === "POST"
      ) {
        const expected = env.REVENUECAT_WEBHOOK_SECRET;
        const provided = request.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "");
        if (!expected || provided !== expected) {
          return json(
            apiError("WEBHOOK_UNAUTHORIZED", "Webhook 未授权"),
            401,
            origin,
          );
        }
        const body = (await request.json()) as any;
        const event = body?.event;
        if (!event?.app_user_id || !event?.type) {
          return json(
            apiError("INVALID_WEBHOOK", "Webhook 数据无效"),
            400,
            origin,
          );
        }
        const eventId = String(
          event.id ||
            body.id ||
            `${event.type}:${event.app_user_id}:${event.transaction_id || event.product_id}:${event.event_timestamp_ms || "unknown"}`,
        );
        const duplicate = await env.DB.prepare(
          "SELECT event_id FROM webhook_events WHERE event_id=?",
        )
          .bind(eventId)
          .first();
        if (duplicate) return json({ ok: true, duplicate: true }, 200, origin);
        const user = await env.DB.prepare("SELECT id FROM users WHERE id=?")
          .bind(String(event.app_user_id))
          .first<{ id: string }>();
        if (!user)
          return json(apiError("USER_NOT_FOUND", "用户不存在"), 404, origin);
        const revoked = ["EXPIRATION", "REFUND", "BILLING_ISSUE"].includes(
          event.type,
        );
        const status = revoked ? "revoked" : "active";
        const expiresAt = event.expiration_at_ms
          ? Number(event.expiration_at_ms)
          : null;
        const productId = String(event.product_id || "unknown");
        const transactionId = event.transaction_id
          ? String(event.transaction_id)
          : null;
        const originalId = event.original_transaction_id
          ? String(event.original_transaction_id)
          : transactionId;
        const entitlementIds =
          Array.isArray(event.entitlement_ids) && event.entitlement_ids.length
            ? event.entitlement_ids
            : ["premium"];
        for (const entitlement of entitlementIds) {
          const key = originalId || `${productId}:${entitlement}`;
          const now = Date.now();
          const existing = await env.DB.prepare(
            "SELECT updated_at FROM entitlements WHERE user_id=? AND entitlement=? AND original_transaction_id=?",
          )
            .bind(user.id, String(entitlement), key)
            .first<{ updated_at: number }>();
          const eventTime = Number(event.event_timestamp_ms || now);
          if (existing && eventTime < existing.updated_at) continue;
          await env.DB.prepare(
            `INSERT INTO entitlements
            (id,user_id,platform,product_id,transaction_id,original_transaction_id,entitlement,status,expires_at,environment,raw_event,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id,entitlement,original_transaction_id) DO UPDATE SET
              product_id=excluded.product_id, transaction_id=excluded.transaction_id,
              status=excluded.status, expires_at=excluded.expires_at,
              environment=excluded.environment, raw_event=excluded.raw_event,
              updated_at=excluded.updated_at`,
          )
            .bind(
              id(),
              user.id,
              event.store || "unknown",
              productId,
              transactionId,
              key,
              String(entitlement),
              status,
              expiresAt,
              event.environment || null,
              JSON.stringify(event),
              now,
              now,
            )
            .run();
          await env.DB.prepare(
            `INSERT INTO entitlement_events
            (id,user_id,entitlement,event_type,product_id,transaction_id,status,expires_at,environment,raw_event,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          )
            .bind(
              id(),
              user.id,
              String(entitlement),
              String(event.type),
              productId,
              transactionId,
              status,
              expiresAt,
              event.environment || null,
              JSON.stringify(event),
              now,
            )
            .run();
        }
        await env.DB.prepare(
          "INSERT INTO webhook_events (event_id,provider,event_type,received_at) VALUES (?,?,?,?)",
        )
          .bind(eventId, "revenuecat", String(event.type), Date.now())
          .run();
        return json({ ok: true }, 200, origin);
      }
      const user = await auth(request, env);
      if (!user)
        return json(apiError("AUTH_REQUIRED", "需要登录"), 401, origin);
      if (url.pathname === "/v1/admin/metrics" && request.method === "GET") {
        if (user.role !== "admin")
          return json(
            apiError("ADMIN_REQUIRED", "需要管理员权限"),
            403,
            origin,
          );
        const [users, records, entitlements] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<any>(),
          env.DB.prepare(
            "SELECT COUNT(*) AS count FROM mood_records",
          ).first<any>(),
          env.DB.prepare(
            "SELECT COUNT(*) AS count FROM entitlements WHERE status='active' AND (expires_at IS NULL OR expires_at>?)",
          )
            .bind(Date.now())
            .first<any>(),
        ]);
        return json(
          {
            users: users?.count || 0,
            records: records?.count || 0,
            activeEntitlements: entitlements?.count || 0,
          },
          200,
          origin,
        );
      }
      if (url.pathname === "/v1/products" && request.method === "GET") {
        return json({ products: PRODUCTS }, 200, origin);
      }
      if (url.pathname === "/v1/billing/cancel" && request.method === "POST") {
        return json(
          {
            ok: true,
            manageUrl: "https://apps.apple.com/account/subscriptions",
            message: "请在应用商店管理自动续费",
          },
          200,
          origin,
        );
      }
      if (url.pathname === "/v1/me" && request.method === "GET")
        return json({ user }, 200, origin);
      if (
        (url.pathname === "/v1/entitlements" ||
          url.pathname === "/v1/billing/status") &&
        request.method === "GET"
      ) {
        const rows = await env.DB.prepare(
          "SELECT entitlement,product_id,platform,status,expires_at,environment FROM entitlements WHERE user_id=? ORDER BY updated_at DESC",
        )
          .bind(user.id)
          .all<any>();
        const entitlements = rows.results.map((row) => ({
          ...row,
          active: entitlementActive(row.status, row.expires_at),
        }));
        return json(
          {
            entitlements,
            premium: entitlements.some(
              (row) => row.entitlement === "premium" && row.active,
            ),
          },
          200,
          origin,
        );
      }
      if (
        (url.pathname === "/v1/entitlements/history" ||
          url.pathname === "/v1/billing/history") &&
        request.method === "GET"
      ) {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") || 50), 1),
          100,
        );
        const rows = await env.DB.prepare(
          "SELECT entitlement,event_type,product_id,transaction_id,status,expires_at,environment,created_at FROM entitlement_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
        )
          .bind(user.id, limit)
          .all();
        return json({ events: rows.results }, 200, origin);
      }
      if (
        url.pathname === "/v1/entitlements/restore" &&
        request.method === "POST"
      ) {
        return json(
          {
            ok: true,
            premium: await refreshRevenueCat(env, user),
            message: "权益已刷新",
          },
          200,
          origin,
        );
      }
      if (
        url.pathname === "/v1/entitlements/refresh" &&
        request.method === "POST"
      ) {
        return json(
          {
            ok: true,
            premium: await refreshRevenueCat(env, user),
            refreshedAt: Date.now(),
          },
          200,
          origin,
        );
      }
      if (url.pathname === "/v1/me/export" && request.method === "GET") {
        const [records, settings, entitlements] = await Promise.all([
          env.DB.prepare(
            "SELECT * FROM mood_records WHERE user_id=? ORDER BY created_at ASC",
          )
            .bind(user.id)
            .all(),
          env.DB.prepare(
            "SELECT key,value,updated_at FROM user_settings WHERE user_id=?",
          )
            .bind(user.id)
            .all(),
          env.DB.prepare(
            "SELECT entitlement,product_id,status,expires_at,environment,created_at,updated_at FROM entitlements WHERE user_id=?",
          )
            .bind(user.id)
            .all(),
        ]);
        return new Response(
          JSON.stringify({
            exportedAt: Date.now(),
            records: records.results,
            settings: settings.results,
            entitlements: entitlements.results,
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-disposition":
                'attachment; filename="huehaven-export.json"',
              "access-control-allow-origin": origin,
            },
          },
        );
      }
      if (
        url.pathname === "/v1/me/privacy/location" &&
        request.method === "DELETE"
      ) {
        await env.DB.prepare(
          "UPDATE mood_records SET latitude=NULL,longitude=NULL,accuracy=NULL,place_name=NULL WHERE user_id=?",
        )
          .bind(user.id)
          .run();
        return json({ ok: true }, 200, origin);
      }
      if (url.pathname === "/v1/ai/analyze" && request.method === "POST") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const body = (await request.json()) as any;
        if (!env.AI)
          return json(
            apiError("AI_NOT_CONFIGURED", "AI 服务尚未配置"),
            503,
            origin,
          );
        let input = body;
        if (body.recordId) {
          const record = await env.DB.prepare(
            "SELECT primary_color,secondary_color,tertiary_color,emotion_id,place_name,note,activity_tags,created_at FROM mood_records WHERE id=? AND user_id=?",
          )
            .bind(body.recordId, user.id)
            .first<any>();
          if (!record)
            return json(
              apiError("RECORD_NOT_FOUND", "记录不存在"),
              404,
              origin,
            );
          input = record;
        }
        const prompt = `你是一个温和、谨慎的情绪记录助手。只输出有效 JSON，字段必须包含 summary、signals、suggestions。不要进行医学诊断，不要编造事实。建议要具体、温和、可执行。记录：${JSON.stringify(input)}`;
        const model = env.AI_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8";
        const raw = await env.AI.run(model, { prompt });
        const result =
          typeof raw === "string"
            ? (() => {
                try {
                  return JSON.parse(raw);
                } catch {
                  return { summary: raw, signals: [], suggestions: [] };
                }
              })()
            : raw;
        const analysisId = id();
        await env.DB.prepare(
          "INSERT INTO ai_analyses (id,user_id,record_id,model,result,created_at) VALUES (?,?,?,?,?,?)",
        )
          .bind(
            analysisId,
            user.id,
            body.recordId || null,
            model,
            JSON.stringify(result),
            Date.now(),
          )
          .run();
        return json({ id: analysisId, result }, 200, origin);
      }
      if (url.pathname === "/v1/ai/analyses" && request.method === "GET") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") || 20), 1),
          50,
        );
        const rows = await env.DB.prepare(
          "SELECT id,record_id,model,result,created_at FROM ai_analyses WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
        )
          .bind(user.id, limit)
          .all();
        return json({ analyses: rows.results }, 200, origin);
      }
      const analysisMatch = url.pathname.match(/^\/v1\/ai\/analyses\/([^/]+)$/);
      if (analysisMatch && request.method === "GET") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const row = await env.DB.prepare(
          "SELECT id,record_id,model,result,created_at FROM ai_analyses WHERE id=? AND user_id=?",
        )
          .bind(analysisMatch[1], user.id)
          .first();
        return row
          ? json({ analysis: row }, 200, origin)
          : json(apiError("ANALYSIS_NOT_FOUND", "分析结果不存在"), 404, origin);
      }
      if (url.pathname === "/v1/push-tokens" && request.method === "PUT") {
        const body = (await request.json()) as any;
        if (
          typeof body.token !== "string" ||
          body.token.length < 10 ||
          body.token.length > 512
        )
          return json(
            apiError("INVALID_PUSH_TOKEN", "推送令牌无效"),
            400,
            origin,
          );
        await env.DB.prepare(
          "INSERT OR REPLACE INTO push_tokens (user_id,token,platform,updated_at) VALUES (?,?,?,?)",
        )
          .bind(user.id, body.token, body.platform || null, Date.now())
          .run();
        return json({ ok: true }, 200, origin);
      }
      if (url.pathname === "/v1/push-tokens" && request.method === "DELETE") {
        const body = (await request.json().catch(() => ({}))) as any;
        if (body.token)
          await env.DB.prepare(
            "DELETE FROM push_tokens WHERE user_id=? AND token=?",
          )
            .bind(user.id, body.token)
            .run();
        return json({ ok: true }, 200, origin);
      }
      if (url.pathname === "/v1/settings" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT key,value,updated_at FROM user_settings WHERE user_id=? ORDER BY key",
        )
          .bind(user.id)
          .all();
        const settings: Record<string, string> = {};
        for (const row of rows.results as any[]) settings[row.key] = row.value;
        return json({ settings }, 200, origin);
      }
      if (url.pathname === "/v1/settings" && request.method === "PUT") {
        const body = (await request.json()) as any;
        if (
          !body ||
          typeof body.settings !== "object" ||
          Array.isArray(body.settings)
        )
          return json(
            apiError("INVALID_SETTINGS", "设置格式无效"),
            400,
            origin,
          );
        const entries = Object.entries(body.settings);
        if (
          entries.length > 50 ||
          entries.some(
            ([key, value]) =>
              key.length > 100 ||
              typeof value !== "string" ||
              value.length > 5000,
          )
        )
          return json(
            apiError("INVALID_SETTINGS", "设置内容超出限制"),
            400,
            origin,
          );
        const now = Date.now();
        for (const [key, value] of entries)
          await env.DB.prepare(
            "INSERT OR REPLACE INTO user_settings (user_id,key,value,updated_at) VALUES (?,?,?,?)",
          )
            .bind(user.id, key, value, now)
            .run();
        return json({ ok: true, updatedAt: now }, 200, origin);
      }
      if (url.pathname === "/v1/backups" && request.method === "POST") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > 10 * 1024 * 1024)
          return json(
            apiError("BACKUP_TOO_LARGE", "备份文件不能超过 10MB"),
            413,
            origin,
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(
            apiError("INVALID_BACKUP", "备份内容不是有效 JSON"),
            400,
            origin,
          );
        }
        const backupId = id();
        const key = `${user.id}/backups/${backupId}.json`;
        await env.MEDIA.put(key, body, {
          httpMetadata: { contentType: "application/json" },
        });
        await env.DB.prepare(
          "INSERT INTO backups (id,user_id,object_key,size_bytes,created_at) VALUES (?,?,?,?,?)",
        )
          .bind(
            backupId,
            user.id,
            key,
            new TextEncoder().encode(body).byteLength,
            Date.now(),
          )
          .run();
        return json(
          {
            id: backupId,
            sizeBytes: new TextEncoder().encode(body).byteLength,
          },
          201,
          origin,
        );
      }
      if (url.pathname === "/v1/backups" && request.method === "GET") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const rows = await env.DB.prepare(
          "SELECT id,size_bytes,created_at FROM backups WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
        )
          .bind(user.id)
          .all();
        return json({ backups: rows.results }, 200, origin);
      }
      const backupMatch = url.pathname.match(/^\/v1\/backups\/([^/]+)$/);
      if (backupMatch && request.method === "GET") {
        const row = await env.DB.prepare(
          "SELECT object_key FROM backups WHERE id=? AND user_id=?",
        )
          .bind(backupMatch[1], user.id)
          .first<any>();
        if (!row)
          return json(apiError("BACKUP_NOT_FOUND", "备份不存在"), 404, origin);
        const object = await env.MEDIA.get(row.object_key);
        return object
          ? new Response(object.body, {
              headers: {
                "content-type": "application/json",
                "content-disposition": `attachment; filename="${backupMatch[1]}.json"`,
                "access-control-allow-origin": origin,
              },
            })
          : json(apiError("BACKUP_NOT_FOUND", "备份不存在"), 404, origin);
      }
      if (backupMatch && request.method === "DELETE") {
        const row = await env.DB.prepare(
          "SELECT object_key FROM backups WHERE id=? AND user_id=?",
        )
          .bind(backupMatch[1], user.id)
          .first<any>();
        if (!row)
          return json(apiError("BACKUP_NOT_FOUND", "备份不存在"), 404, origin);
        await env.MEDIA.delete(row.object_key);
        await env.DB.prepare("DELETE FROM backups WHERE id=? AND user_id=?")
          .bind(backupMatch[1], user.id)
          .run();
        return json({ ok: true }, 200, origin);
      }

      if (url.pathname === "/v1/me" && request.method === "DELETE") {
        let cursor: string | undefined;
        do {
          const listed = await env.MEDIA.list({
            prefix: `${user.id}/`,
            ...(cursor ? { cursor } : {}),
          });
          for (const object of listed.objects)
            await env.MEDIA.delete(object.key);
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
        await env.DB.prepare("DELETE FROM users WHERE id=?")
          .bind(user.id)
          .run();
        return json({ ok: true }, 200, origin);
      }

      if (url.pathname === "/v1/auth/sessions" && request.method === "GET") {
        const sessions = await env.DB.prepare(
          "SELECT created_at,expires_at FROM sessions WHERE user_id=? ORDER BY created_at DESC",
        )
          .bind(user.id)
          .all();
        return json({ sessions: sessions.results }, 200, origin);
      }
      if (url.pathname === "/v1/auth/logout-all" && request.method === "POST") {
        await env.DB.prepare("DELETE FROM sessions WHERE user_id=?")
          .bind(user.id)
          .run();
        return json({ ok: true }, 200, origin);
      }
      if (url.pathname === "/v1/reports/summary" && request.method === "GET") {
        if (!(await hasPremium(env, user.id)))
          return json(
            apiError("PREMIUM_REQUIRED", "需要 premium 权益"),
            403,
            origin,
          );
        const end = Number(url.searchParams.get("end") || Date.now());
        const start = Number(
          url.searchParams.get("start") || end - 30 * 86400000,
        );
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start > end ||
          end - start > 365 * 86400000
        )
          return json({ error: "报告时间范围必须在 365 天以内" }, 400, origin);
        const rows = await env.DB.prepare(
          "SELECT * FROM mood_records WHERE user_id=? AND created_at>=? AND created_at<=? ORDER BY created_at ASC",
        )
          .bind(user.id, start, end)
          .all<any>();
        const daily: Record<
          string,
          {
            date: string;
            count: number;
            emotions: Record<string, number>;
            colors: Record<string, number>;
          }
        > = {};
        const colors: Record<string, number> = {};
        const activities: Record<
          string,
          { count: number; emotions: Record<string, number> }
        > = {};
        for (const row of rows.results) {
          const date = new Date(row.created_at).toISOString().slice(0, 10);
          const day = (daily[date] ||= {
            date,
            count: 0,
            emotions: {},
            colors: {},
          });
          day.count++;
          day.emotions[row.emotion_id] =
            (day.emotions[row.emotion_id] || 0) + 1;
          day.colors[row.primary_color] =
            (day.colors[row.primary_color] || 0) + 1;
          colors[row.primary_color] = (colors[row.primary_color] || 0) + 1;
          let tags: string[] = [];
          try {
            tags = row.activity_tags ? JSON.parse(row.activity_tags) : [];
          } catch {}
          for (const tag of tags) {
            const item = (activities[tag] ||= { count: 0, emotions: {} });
            item.count++;
            item.emotions[row.emotion_id] =
              (item.emotions[row.emotion_id] || 0) + 1;
          }
        }
        return json(
          {
            start,
            end,
            total: rows.results.length,
            daily: Object.values(daily),
            colors,
            activities,
          },
          200,
          origin,
        );
      }
      if (url.pathname === "/v1/records" && request.method === "GET") {
        const limit = Math.min(
          Math.max(Number(url.searchParams.get("limit") || 50), 1),
          100,
        );
        const since = Math.max(Number(url.searchParams.get("since") || 0), 0);
        const cursor = Math.max(Number(url.searchParams.get("cursor") || 0), 0);
        const rows = await env.DB.prepare(
          "SELECT * FROM mood_records WHERE user_id=? AND updated_at>? AND updated_at>? ORDER BY updated_at ASC LIMIT ?",
        )
          .bind(user.id, since, cursor, limit + 1)
          .all<any>();
        const deleted = await env.DB.prepare(
          "SELECT id,deleted_at FROM deleted_records WHERE user_id=? AND deleted_at>? ORDER BY deleted_at ASC LIMIT ?",
        )
          .bind(user.id, since, limit)
          .all();
        const hasMore = rows.results.length > limit;
        const records = hasMore ? rows.results.slice(0, limit) : rows.results;
        const nextCursor = hasMore
          ? records[records.length - 1].updated_at
          : null;
        return json(
          {
            records,
            deleted: deleted.results,
            nextCursor,
            serverTime: Date.now(),
          },
          200,
          origin,
        );
      }
      if (url.pathname === "/v1/records" && request.method === "POST") {
        const b = (await request.json()) as any;
        if (!b.primaryColor || !b.emotionId)
          return json(
            apiError("INVALID_RECORD", "缺少颜色或情绪"),
            400,
            origin,
          );
        const now = Date.now(),
          record = {
            id: b.id || id(),
            user_id: user.id,
            primary_color: b.primaryColor,
            secondary_color: b.secondaryColor ?? null,
            tertiary_color: b.tertiaryColor ?? null,
            emotion_id: b.emotionId,
            latitude: b.latitude ?? null,
            longitude: b.longitude ?? null,
            accuracy: b.accuracy ?? null,
            place_name: b.placeName ?? null,
            photo_key: b.photoKey ?? null,
            thumbnail_key: b.thumbnailKey ?? null,
            note: b.note ?? null,
            activity_tags: b.activityTags
              ? JSON.stringify(b.activityTags)
              : null,
            source_asset_id: b.sourceAssetId ?? null,
            created_at: b.createdAt ?? now,
            updated_at: now,
          };
        const existing = await env.DB.prepare(
          "SELECT user_id FROM mood_records WHERE id=?",
        )
          .bind(record.id)
          .first<any>();
        if (existing && existing.user_id !== user.id)
          return json(
            apiError("RECORD_CONFLICT", "记录 ID 已被占用"),
            409,
            origin,
          );
        await env.DB.prepare(
          `INSERT INTO mood_records (id,user_id,primary_color,secondary_color,tertiary_color,emotion_id,latitude,longitude,accuracy,place_name,photo_key,thumbnail_key,note,activity_tags,source_asset_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET primary_color=excluded.primary_color,secondary_color=excluded.secondary_color,tertiary_color=excluded.tertiary_color,emotion_id=excluded.emotion_id,latitude=excluded.latitude,longitude=excluded.longitude,accuracy=excluded.accuracy,place_name=excluded.place_name,photo_key=excluded.photo_key,thumbnail_key=excluded.thumbnail_key,note=excluded.note,activity_tags=excluded.activity_tags,source_asset_id=excluded.source_asset_id,updated_at=excluded.updated_at WHERE mood_records.user_id=excluded.user_id`,
        )
          .bind(...Object.values(record))
          .run();
        return json(
          { record, created: !existing },
          existing ? 200 : 201,
          origin,
        );
      }
      const match = url.pathname.match(/^\/v1\/records\/([^/]+)$/);
      if (match && request.method === "PUT") {
        const b = (await request.json()) as any;
        const now = Date.now();
        const existing = await env.DB.prepare(
          "SELECT id FROM mood_records WHERE id=? AND user_id=?",
        )
          .bind(match[1], user.id)
          .first();
        if (!existing)
          return json(apiError("RECORD_NOT_FOUND", "记录不存在"), 404, origin);
        await env.DB.prepare(
          "UPDATE mood_records SET primary_color=?,secondary_color=?,tertiary_color=?,emotion_id=?,latitude=?,longitude=?,accuracy=?,place_name=?,photo_key=?,thumbnail_key=?,note=?,activity_tags=?,updated_at=? WHERE id=? AND user_id=?",
        )
          .bind(
            b.primaryColor,
            b.secondaryColor ?? null,
            b.tertiaryColor ?? null,
            b.emotionId,
            b.latitude ?? null,
            b.longitude ?? null,
            b.accuracy ?? null,
            b.placeName ?? null,
            b.photoKey ?? null,
            b.thumbnailKey ?? null,
            b.note ?? null,
            b.activityTags ? JSON.stringify(b.activityTags) : null,
            now,
            match[1],
            user.id,
          )
          .run();
        return json({ ok: true }, 200, origin);
      }
      if (match && request.method === "DELETE") {
        const now = Date.now();
        const record = await env.DB.prepare(
          "SELECT photo_key,thumbnail_key FROM mood_records WHERE id=? AND user_id=?",
        )
          .bind(match[1], user.id)
          .first<any>();
        await env.DB.prepare(
          "DELETE FROM mood_records WHERE id=? AND user_id=?",
        )
          .bind(match[1], user.id)
          .run();
        if (record?.photo_key) await env.MEDIA.delete(record.photo_key);
        if (record?.thumbnail_key) await env.MEDIA.delete(record.thumbnail_key);
        await env.DB.prepare(
          "INSERT OR REPLACE INTO deleted_records (id,user_id,deleted_at) VALUES (?,?,?)",
        )
          .bind(match[1], user.id, now)
          .run();
        return json({ ok: true }, 200, origin);
      }
      if (url.pathname.startsWith("/v1/media/") && request.method === "PUT") {
        const contentType = request.headers.get("content-type") || "";
        const contentLength = Number(
          request.headers.get("content-length") || 0,
        );
        if (
          !/^image\/(jpeg|png|webp|heic)$/.test(contentType.split(";")[0]) ||
          contentLength > 15 * 1024 * 1024
        )
          return json(
            apiError("INVALID_MEDIA", "仅支持 15MB 以内的图片"),
            413,
            origin,
          );
        const key = `${user.id}/${url.pathname.slice("/v1/media/".length)}`;
        await env.MEDIA.put(key, request.body, {
          httpMetadata: {
            contentType: request.headers.get("content-type") || "image/jpeg",
          },
        });
        return json({ key }, 201, origin);
      }
      if (url.pathname.startsWith("/v1/media/") && request.method === "GET") {
        const key = `${user.id}/${url.pathname.slice("/v1/media/".length)}`;
        const obj = await env.MEDIA.get(key);
        return obj
          ? new Response(obj.body, {
              headers: {
                "content-type":
                  obj.httpMetadata?.contentType || "application/octet-stream",
                "access-control-allow-origin": origin,
              },
            })
          : json(apiError("MEDIA_NOT_FOUND", "文件不存在"), 404, origin);
      }
      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      console.error(e);
      return json(apiError("INTERNAL_ERROR", "服务器内部错误"), 500, origin);
    }
  },
  async scheduled(_event: unknown, env: Env) {
    const now = Date.now();
    const windows = [
      { kind: "7_days", from: now + 6 * 86400000, to: now + 8 * 86400000 },
      { kind: "1_day", from: now + 0.5 * 86400000, to: now + 1.5 * 86400000 },
    ];
    for (const window of windows) {
      const rows = await env.DB.prepare(
        "SELECT user_id,entitlement,expires_at FROM entitlements WHERE status='active' AND expires_at>? AND expires_at<=?",
      )
        .bind(window.from, window.to)
        .all<any>();
      for (const row of rows.results) {
        const inserted = (await env.DB.prepare(
          "INSERT OR IGNORE INTO entitlement_reminders (id,user_id,entitlement,kind,due_at,created_at) VALUES (?,?,?,?,?,?)",
        )
          .bind(
            id(),
            row.user_id,
            row.entitlement,
            window.kind,
            row.expires_at,
            now,
          )
          .run()) as any;
        if (!inserted?.changes) continue;
        const tokens = await env.DB.prepare(
          "SELECT token FROM push_tokens WHERE user_id=?",
        )
          .bind(row.user_id)
          .all<{ token: string }>();
        for (const tokenRow of tokens.results) {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              to: tokenRow.token,
              title: "订阅即将到期",
              body:
                row.kind === "7_days"
                  ? "你的 premium 订阅将在 7 天后到期"
                  : "你的 premium 订阅将在 1 天后到期",
              data: {
                type: "entitlement_expiring",
                entitlement: row.entitlement,
              },
            }),
          });
        }
      }
    }
  },
};
