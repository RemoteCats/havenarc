// Server-only. The `.server.ts` suffix keeps this module — and the service-role
// key it reads — out of the browser bundle. Import it with a dynamic
// `await import("./_shared.server")` from inside server function handlers and
// server route handlers, never at the top level of a module the client loads.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { htmlToText } from "../html-to-text.ts";
import { parseMime, type MimeBody } from "../mime.ts";
import { createHmac, timingSafeEqual } from "node:crypto";

export { htmlToText };

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** First non-empty value among `names`, or undefined. */
export function env(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

// Every accepted spelling, exported so /api/health can name all of them when
// one is missing. Connecting Vercel's Supabase integration sets the first
// group; a hand-rolled .env may use any of the others.
export const SUPABASE_URL_NAMES = ["SUPABASE_URL", "VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"];

export const SUPABASE_ANON_KEY_NAMES = [
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

export const SERVICE_ROLE_KEY_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SERVICE_ROLE_KEY",
];

export const RESEND_API_KEY_NAMES = ["RESEND_API_KEY"];
export const RESEND_WEBHOOK_SECRET_NAMES = ["RESEND_WEBHOOK_SECRET", "RESEND_SIGNING_SECRET"];
export const MAIL_DOMAIN_NAMES = ["MAIL_DOMAIN"];

export const SUPABASE_URL = env(SUPABASE_URL_NAMES);
export const SUPABASE_ANON_KEY = env(SUPABASE_ANON_KEY_NAMES);
export const SERVICE_ROLE_KEY = env(SERVICE_ROLE_KEY_NAMES);
export const RESEND_API_KEY = env(RESEND_API_KEY_NAMES);
export const RESEND_WEBHOOK_SECRET = env(RESEND_WEBHOOK_SECRET_NAMES);

/** One domain drives every address, so there is a single thing to change. */
export const MAIL_DOMAIN = env(MAIL_DOMAIN_NAMES) ?? "example.com";
export const MAIL_FROM = env(["MAIL_FROM"]) ?? `Meastro Architecture <no-reply@${MAIL_DOMAIN}>`;
export const MAIL_REPLY_TO = env(["MAIL_REPLY_TO"]) ?? `hello@${MAIL_DOMAIN}`;
/** Where visitor notifications land. Never point this back at MAIL_DOMAIN's
 *  own inbound route, or mail loops through the webhook until quota runs out. */
export const MAIL_NOTIFY_TO = env(["MAIL_NOTIFY_TO", "NOTIFY_TO", "STAFF_EMAIL"]) ?? MAIL_REPLY_TO;

/**
 * What is wrong with a configured mail address, or null when it is fine.
 *
 * `env()` trims the ends of a value but cannot see inside it, so an address
 * pasted over several lines survives as one string with newlines in the middle.
 * That is a broken header rather than a broken address, and neither Resend nor
 * the recipient will tell you which variable did it.
 */
export function mailAddressIssue(value: string): string | null {
  // A newline at either end is just whitespace that survived the paste.
  const trimmed = value.replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");

  if (/[\r\n]/.test(trimmed)) {
    const lines = trimmed
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const unique = [...new Set(lines)];
    return unique.length === 1
      ? `holds the same address ${lines.length} times on separate lines; it should be one line`
      : `holds ${lines.length} addresses on separate lines; it should be one`;
  }
  // `Name <a@b.com>` and a bare `a@b.com` are both fine; anything else is not.
  const bare = (/<([^>]*)>/.exec(trimmed)?.[1] ?? trimmed).trim();
  if (!bare) return "is empty";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare)) return `is not an email address: ${bare}`;
  return null;
}

/** The address part of `Name <a@b.com>`, or the value itself. */
export function bareAddress(value: string): string {
  return (/<([^>]*)>/.exec(value)?.[1] ?? value).trim();
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

let cachedAdminClient: SupabaseClient | undefined;

/** Service-role client. Bypasses RLS — server code only. */
export function adminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      `Supabase is not configured on the server. Set ${SUPABASE_URL_NAMES[0]} and ${SERVICE_ROLE_KEY_NAMES[0]} in your deployment environment (Vercel → Settings → Environment Variables). See /api/health for what this server can currently see.`,
    );
  }
  cachedAdminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdminClient;
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

export type SendEmailOptions = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** Message-Id of the mail being answered; sets In-Reply-To and References. */
  inReplyTo?: string;
};

/**
 * Returns the Resend message id, or null when no API key is set. Notification
 * mail is a side effect of a form submission — losing it must not turn a
 * successful write into a failed request, so this reports rather than throws.
 */
export async function sendEmail(options: SendEmailOptions): Promise<string | null> {
  if (!RESEND_API_KEY) {
    console.warn("[mail] RESEND_API_KEY is unset — skipping send:", options.subject);
    return null;
  }

  // A newline in any of these is a malformed header, not just a bad address.
  // Fail loudly and name the variable rather than handing Resend something it
  // will reject with no clue where it came from.
  for (const [label, value] of [
    ["MAIL_FROM", options.from ?? MAIL_FROM],
    ["MAIL_REPLY_TO", options.replyTo ?? ""],
    ["the recipient", Array.isArray(options.to) ? options.to.join(",") : options.to],
  ] as const) {
    if (!value) continue;
    const issue = mailAddressIssue(value);
    if (issue) {
      throw new Error(
        `Refusing to send: ${label} ${issue}. Fix it in Vercel → Settings → Environment Variables, then redeploy. See /api/health.`,
      );
    }
  }

  const payload: Record<string, unknown> = {
    from: options.from ?? MAIL_FROM,
    to: Array.isArray(options.to) ? options.to : [options.to],
    subject: options.subject,
    html: options.html,
  };
  if (options.text) payload["text"] = options.text;
  if (options.replyTo) payload["reply_to"] = options.replyTo;
  if (options.inReplyTo) {
    payload["headers"] = {
      "In-Reply-To": options.inReplyTo,
      References: options.inReplyTo,
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => null)) as {
    id?: string;
    message?: string;
  } | null;
  if (!response.ok) {
    throw new Error(
      `Resend rejected the send (${response.status}): ${body?.message ?? "unknown error"}`,
    );
  }
  return body?.id ?? null;
}

// ---------------------------------------------------------------------------
// Admin authentication
// ---------------------------------------------------------------------------

export type AdminIdentity = { userId: string; email: string };

/**
 * Validates the caller's bearer token by asking Supabase Auth — not by
 * decoding the JWT locally, which proves nothing about the signature — then
 * confirms the user is on the `admins` list using the service role.
 */
export async function requireAdmin(request: Request): Promise<AdminIdentity> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) throw new Error("Unauthorized: no bearer token on the request.");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      `Supabase is not configured on the server. Set ${SUPABASE_URL_NAMES[0]} and ${SUPABASE_ANON_KEY_NAMES[0]}.`,
    );
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) throw new Error("Unauthorized: the session token is not valid.");

  // Anonymous visitors hold a real auth.uid() for chat RLS. They are never staff.
  if (data.user.is_anonymous)
    throw new Error("Unauthorized: anonymous sessions cannot use the dashboard.");

  const { data: row, error: lookupError } = await adminClient()
    .from("admins")
    .select("user_id, email")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (lookupError) throw new Error(`Could not check the admin list: ${lookupError.message}`);
  if (!row) throw new Error("Forbidden: this account is not on the admin list.");

  return { userId: data.user.id, email: data.user.email ?? String(row["email"] ?? "") };
}

// ---------------------------------------------------------------------------
// Resend webhook signatures (Svix)
// ---------------------------------------------------------------------------

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Base64 body of a `whsec_`-prefixed Svix secret, as raw key bytes. */
export function decodeWebhookSecret(secret: string): Buffer | null {
  const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const key = Buffer.from(body, "base64");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * A readable verdict on the webhook secret's shape, for /api/health.
 *
 * `decodeWebhookSecret` alone is not enough to say a secret is usable: Node's
 * base64 decoder silently drops characters it does not recognise, so a Resend
 * API key pasted into this slot by mistake decodes to eighteen bytes and looks
 * fine. The two values sit next to each other on the same settings screen and
 * are easy to swap, and the symptom is every inbound delivery failing its
 * signature check with nothing to say why. So check the shape as well.
 */
export function describeWebhookSecret(secret: string | undefined): string {
  if (!secret) return "unset, which is only needed to receive mail";

  if (secret.startsWith("re_")) {
    return "SET BUT WRONG: this is a Resend API key, not a signing secret. The signing secret starts whsec_ and is on the inbound endpoint in Resend, not on the API keys page.";
  }
  if (secret.startsWith("sb_") || secret.startsWith("eyJ")) {
    return "SET BUT WRONG: this looks like a Supabase key. Copy the whsec_ value from the inbound endpoint in Resend.";
  }
  if (!secret.startsWith("whsec_")) {
    return "SET BUT SUSPECT: a Svix signing secret starts whsec_ and this does not. Copy it from the inbound endpoint in Resend.";
  }

  const key = decodeWebhookSecret(secret);
  if (!key) {
    return "SET BUT UNUSABLE: it does not base64-decode to a key. Copy the whsec_ value from Resend again.";
  }
  if (key.length < 16) {
    return `SET BUT SUSPECT: it decodes to only ${key.length} bytes, where a signing secret is usually 24 or more. Check nothing was truncated on paste.`;
  }
  return `looks right: whsec_ prefix, decodes to ${key.length} bytes`;
}

function pickHeader(headers: Headers, ...names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Svix HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`. Returns a reason on
 * failure rather than a bare false, so the route can log why a delivery was
 * dropped instead of guessing.
 */
export function verifyResendWebhook(rawBody: string, headers: Headers): WebhookVerification {
  if (!RESEND_WEBHOOK_SECRET) {
    return { ok: false, reason: `${RESEND_WEBHOOK_SECRET_NAMES[0]} is not set on this server.` };
  }
  const key = decodeWebhookSecret(RESEND_WEBHOOK_SECRET);
  if (!key) {
    return {
      ok: false,
      reason: `${RESEND_WEBHOOK_SECRET_NAMES[0]} did not base64-decode to a usable key.`,
    };
  }

  // Resend sends svix-* names; some proxies normalise them to webhook-*.
  const id = pickHeader(headers, "svix-id", "webhook-id");
  const timestamp = pickHeader(headers, "svix-timestamp", "webhook-timestamp");
  const signature = pickHeader(headers, "svix-signature", "webhook-signature");

  const missing = [
    ...(id ? [] : ["svix-id"]),
    ...(timestamp ? [] : ["svix-timestamp"]),
    ...(signature ? [] : ["svix-signature"]),
  ];
  if (missing.length > 0 || !id || !timestamp || !signature) {
    return { ok: false, reason: `missing signature header(s): ${missing.join(", ")}` };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: `timestamp header is not a unix time: ${timestamp}` };
  }
  const skew = Math.abs(Date.now() / 1000 - sentAt);
  if (skew > WEBHOOK_TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: `timestamp is ${Math.round(skew)}s away from now, outside the ${WEBHOOK_TOLERANCE_SECONDS}s window`,
    };
  }

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  // The header carries one or more space-separated `v1,<base64>` versions.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: "no v1 signature in the header matched the computed digest" };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Trimmed string, capped at `max`. Non-strings become "". */
export function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** `"Jane Doe <jane@example.com>"` → `{ name: "Jane Doe", email: "jane@example.com" }` */
export function parseAddress(value: unknown): { name: string | null; email: string } {
  const raw = text(value, 320);
  const angled = /^(.*)<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = (angled[1] ?? "").trim().replace(/^["']|["']$/g, "");
    return { name: name || null, email: (angled[2] ?? "").trim().toLowerCase() };
  }
  return { name: null, email: raw.toLowerCase() };
}

/** Strips any run of `Re:` / `Fwd:` / `Fw:` prefixes so replies thread. */
/**
 * The message body, wherever the provider put it.
 *
 * Resend's inbound payload is the only thing that decides these key names, and
 * getting it wrong is invisible: the mail files successfully with an empty
 * body. So look in the places it could reasonably be, and fall back to the
 * HTML, which is what most mail actually carries.
 */
export function pickBody(data: Record<string, unknown>): { text: string; html: string } {
  const nested = (data["content"] ?? data["body"]) as Record<string, unknown> | undefined;
  const from = (keys: string[]): string => {
    for (const key of keys) {
      const direct = data[key];
      if (typeof direct === "string" && direct.trim() !== "") return direct;
      if (nested && typeof nested === "object") {
        const inner = (nested as Record<string, unknown>)[key];
        if (typeof inner === "string" && inner.trim() !== "") return inner;
      }
    }
    return "";
  };

  const html = from(["html", "body_html", "html_body", "htmlBody"]);
  const plain = from(["text", "plain", "body_text", "text_body", "textBody", "plain_body"]);
  const bodyString = typeof data["body"] === "string" ? data["body"] : "";

  // Some providers hand over the whole RFC 822 message instead of parsed
  // fields, sometimes base64-encoded. Only worth parsing if nothing simpler
  // turned anything up.
  let mime: MimeBody = { text: "", html: "" };
  if (!plain && !html) {
    for (const key of ["raw", "raw_email", "rawEmail", "mime", "message", "email", "content"]) {
      const candidate = data[key];
      if (typeof candidate !== "string" || candidate.trim() === "") continue;
      mime = parseMime(candidate);
      if (mime.text || mime.html) break;
    }
  }

  const finalHtml = html || mime.html;
  return {
    text: plain || mime.text || htmlToText(finalHtml) || bodyString,
    html: finalHtml,
  };
}

/**
 * Retrieve an inbound message's content from Resend, given its id.
 *
 * Resend's inbound webhook delivers the envelope only: sender, recipients,
 * subject, message id, and an `email_id`. The words are not in the payload at
 * all, so they have to be fetched.
 *
 * The exact path is tried rather than assumed. Resend's inbound retrieval
 * endpoint could not be confirmed from where this was written, and a wrong
 * guess hard-coded here would fail the same silent way the missing body did.
 * So each candidate is tried in turn and the outcome of every one is reported,
 * which means the first delivery after deploying either works or says exactly
 * what each path answered.
 */
const INBOUND_PATHS = [
  (id: string) => `/emails/${id}`,
  (id: string) => `/inbound-emails/${id}`,
  (id: string) => `/inbound/emails/${id}`,
  (id: string) => `/emails/inbound/${id}`,
];

export type FetchedBody = {
  text: string;
  html: string;
  /** One line per path tried, for the log and for the filed message. */
  attempts: string[];
};

export async function fetchInboundBody(emailId: string): Promise<FetchedBody> {
  const attempts: string[] = [];
  if (!emailId) return { text: "", html: "", attempts: ["no email_id on the delivery"] };
  if (!RESEND_API_KEY) {
    return {
      text: "",
      html: "",
      attempts: ["RESEND_API_KEY is unset, so the body cannot be fetched"],
    };
  }

  for (const path of INBOUND_PATHS) {
    const url = `https://api.resend.com${path(emailId)}`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, accept: "application/json" },
      });

      if (!response.ok) {
        attempts.push(`${path(emailId)} -> ${response.status}`);
        continue;
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!payload) {
        attempts.push(`${path(emailId)} -> 200 but the response was not JSON`);
        continue;
      }

      // The shape is unknown too, so reuse the same tolerant extraction.
      const body = pickBody((payload["data"] as Record<string, unknown>) ?? payload);
      if (body.text || body.html) {
        attempts.push(`${path(emailId)} -> 200, body found`);
        return { ...body, attempts };
      }
      attempts.push(
        `${path(emailId)} -> 200 but no body in it; fields: ${Object.keys(payload).join(", ")}`,
      );
    } catch (error) {
      attempts.push(`${path(emailId)} -> could not be reached: ${String(error)}`);
    }
  }

  return { text: "", html: "", attempts };
}

/**
 * A readable account of a delivery whose body could not be found anywhere.
 *
 * Better in the dashboard than an empty message: the shape of the payload is
 * the one thing needed to fix it, and it is otherwise only in a server log that
 * whoever notices the blank message may not be able to read.
 */
export function describePayloadShape(data: Record<string, unknown>, limit = 1800): string {
  const shape = Object.entries(data)
    .map(([key, value]) => {
      if (value === null || value === undefined) return `${key}: null`;
      if (Array.isArray(value)) return `${key}: array(${value.length})`;
      if (typeof value === "object") return `${key}: object{${Object.keys(value).join(", ")}}`;
      if (typeof value === "string") {
        const preview = value.length > 80 ? `${value.slice(0, 80)}…` : value;
        return `${key}: "${preview}" (${value.length} chars)`;
      }
      return `${key}: ${String(value)}`;
    })
    .join("\n");

  return [
    "(no body was found on this delivery)",
    "",
    "The message filed, but none of the fields it arrived with held the text.",
    "These are the fields that did arrive, so the right one can be wired up:",
    "",
    shape || "(the payload carried no fields at all)",
  ]
    .join("\n")
    .slice(0, limit);
}

export function normaliseSubject(value: unknown): string {
  let subject = text(value, 500);
  let previous: string;
  do {
    previous = subject;
    subject = subject.replace(/^\s*(re|fwd|fw)\s*(\[\d+\])?\s*:\s*/i, "");
  } while (subject !== previous);
  return subject.trim();
}

/** A plain, readable HTML notification body from label/value rows. */
export function emailBody(heading: string, rows: Array<[string, string]>, footer?: string): string {
  const cells = rows
    .filter(([, value]) => value !== "")
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;color:#111827">${escapeHtml(value).replace(/\n/g, "<br />")}</td></tr>`,
    )
    .join("");

  return `<div style="font:15px/1.6 system-ui,-apple-system,sans-serif;color:#111827">
  <h2 style="font-size:17px;margin:0 0 16px">${escapeHtml(heading)}</h2>
  <table style="border-collapse:collapse">${cells}</table>
  ${footer ? `<p style="margin:20px 0 0;color:#6b7280;font-size:13px">${escapeHtml(footer)}</p>` : ""}
</div>`;
}
