// Server route handler for GET /api/health.
//
// Reports what the *running* server can see, not what the repository expects.
// The most common deploy failure is pointing at a different Supabase project
// than the one whose dashboard is open, so the resolved URL is printed.

import {
  MAIL_DOMAIN,
  MAIL_FROM,
  MAIL_NOTIFY_TO,
  MAIL_REPLY_TO,
  RESEND_API_KEY,
  RESEND_API_KEY_NAMES,
  RESEND_WEBHOOK_SECRET,
  RESEND_WEBHOOK_SECRET_NAMES,
  SERVICE_ROLE_KEY,
  SERVICE_ROLE_KEY_NAMES,
  SUPABASE_ANON_KEY,
  SUPABASE_ANON_KEY_NAMES,
  SUPABASE_URL,
  SUPABASE_URL_NAMES,
  bareAddress,
  describeWebhookSecret,
  mailAddressIssue,
  env,
  json,
} from "./_shared.server";

type ChatReport = {
  reachable: boolean;
  detail: string;
  sessions?: number;
  messages?: number;
  latestMessageAt?: string | null;
  realtime?: string;
};

const HOUR_MS = 60 * 60 * 1000;

/** What the message count and its age together actually say. */
export function describeChatRecency(count: number, latestAt: string | null): string {
  if (count === 0) {
    return "No chat messages have ever been stored. If a visitor has sent one, the write is being refused: /api/health?probe=chat performs that exact write and names the reason.";
  }

  const age = latestAt ? Date.now() - new Date(latestAt).getTime() : Number.NaN;
  if (!Number.isFinite(age)) {
    return `${count} messages are stored. /api/health?probe=chat performs the visitor's write and reports whether it still succeeds.`;
  }

  const hours = Math.floor(age / HOUR_MS);
  if (hours < 24) {
    return `${count} messages stored, the most recent ${hours < 1 ? "within the hour" : `${hours} hour(s) ago`}. The write path was working that recently.`;
  }

  const days = Math.floor(hours / 24);
  return `${count} messages stored, but the most recent is ${days} day(s) old. A total above zero is history, not proof that sending works now; if visitors are being refused, /api/health?probe=chat performs that exact write and names the reason.`;
}

async function inspectChat(): Promise<ChatReport> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { reachable: false, detail: "Supabase is not configured on this server." };
  }
  try {
    const { adminClient } = await import("./_shared.server");
    const db = adminClient();

    const sessions = await db.from("chat_sessions").select("id", { count: "exact", head: true });
    if (sessions.error) {
      return {
        reachable: false,
        detail: `chat_sessions is unreadable: ${sessions.error.message}. Apply supabase/migrations/0001_init.sql.`,
      };
    }

    const messages = await db.from("chat_messages").select("id", { count: "exact", head: true });
    const latest = await db
      .from("chat_messages")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestAt = (latest.data?.["created_at"] as string | undefined) ?? null;

    return {
      reachable: true,
      // A count is a record of the past, not a statement about now. Reporting
      // "messages are reaching the database" off a total above zero read as
      // reassurance while every message sent that day was being refused, so
      // say when the last one actually arrived and let the reader judge.
      detail: describeChatRecency(messages.count ?? 0, latestAt),
      sessions: sessions.count ?? 0,
      messages: messages.count ?? 0,
      latestMessageAt: latestAt,
      realtime:
        "Realtime is a bonus, not a requirement: both surfaces poll as a fallback, so messages arrive within a few seconds either way.",
    };
  } catch (error) {
    return { reachable: false, detail: `Could not reach the database: ${String(error)}` };
  }
}

type EmailReport = {
  reachable: boolean;
  detail: string;
  threads?: number;
  messages?: number;
  latestMessageAt?: string | null;
};

/**
 * Whether anything has ever arrived through the inbound webhook.
 *
 * Mail that never shows up in the dashboard has four possible stopping points
 * and they are indistinguishable from the dashboard itself: the domain's MX
 * records may not point at Resend, so Resend never saw it; there may be no
 * inbound route; the signature check may be rejecting every delivery; or the
 * tables may not exist. A count of zero with the tables present narrows it to
 * the first three, and Resend's own webhook log separates those.
 */
async function inspectEmail(): Promise<EmailReport> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return { reachable: false, detail: "Supabase is not configured on this server." };
  }
  try {
    const { adminClient } = await import("./_shared.server");
    const db = adminClient();

    const threads = await db.from("email_threads").select("id", { count: "exact", head: true });
    if (threads.error) {
      return {
        reachable: false,
        detail:
          "The email tables are not on this project, so inbound mail has nowhere to land. Apply supabase/migrations/0002_email.sql. This is optional; only receiving mail needs it.",
      };
    }

    const messages = await db.from("email_messages").select("id", { count: "exact", head: true });
    const latest = await db
      .from("email_messages")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const count = messages.count ?? 0;
    return {
      reachable: true,
      threads: threads.count ?? 0,
      messages: count,
      latestMessageAt: (latest.data?.["created_at"] as string | undefined) ?? null,
      detail:
        count > 0
          ? // This count is read with the service role, which bypasses RLS, so
            // it says the rows exist and nothing about whether staff can see
            // them. Those two look identical from an empty dashboard.
            "Inbound mail has reached the database. If the dashboard is still empty, the rows are there but unreadable by staff, which is the email_threads_admin_select or email_messages_admin_select policy: the `schema` section above names it, and 0002_email.sql restores it."
          : "The tables are there and empty: no delivery has ever been filed. Receiving mail and forwarding it to a webhook are two separate settings in Resend, and the first can work while the second is missing, so check that a webhook subscribed to email.received points at this deployment's /api/inbound-email. scripts/test-inbound.mjs posts a signed delivery straight to it and settles this in one call.",
    };
  } catch (error) {
    return { reachable: false, detail: `Could not reach the database: ${String(error)}` };
  }
}

type SchemaReport = {
  /** False only when the check ran and found something missing. */
  ok: boolean;
  /** Whether 0006 has been applied at all. A project without it is not broken. */
  installed: boolean;
  detail: string;
  problems: string[];
};

/**
 * What the database says about its own shape.
 *
 * A missing policy is invisible from the outside: the tables are there, the
 * server reads them happily with the service role, and the only symptom is a
 * visitor being refused with "new row violates row-level security policy",
 * which reads like a bug in the widget. schema_report() knows what should be
 * there, so ask it rather than guessing.
 */
async function inspectSchema(): Promise<SchemaReport> {
  try {
    const shared = await import("./_shared.server");
    if (!shared.SUPABASE_URL || !shared.SERVICE_ROLE_KEY) {
      return {
        ok: true,
        installed: false,
        detail: "Supabase is not configured, so the schema was not checked.",
        problems: [],
      };
    }

    const { data, error } = await shared.adminClient().rpc("schema_report");
    if (error) {
      // A project that has not applied 0006 is missing a diagnostic, not a
      // feature. Say so without calling the whole deployment misconfigured.
      return /schema_report|PGRST202|function.*does not exist/i.test(error.message)
        ? {
            ok: true,
            installed: false,
            problems: [],
            detail:
              "The schema check is not installed on this project. Apply supabase/migrations/0006_schema_report.sql to have this page name anything that is missing.",
          }
        : {
            ok: true,
            installed: false,
            problems: [],
            detail: `Could not run the schema check: ${error.message}`,
          };
    }

    const problems = Array.isArray(data) ? data.map(String) : [];
    return problems.length === 0
      ? {
          ok: true,
          installed: true,
          problems,
          detail: "every table, column, policy, trigger and publication membership is present",
        }
      : {
          ok: false,
          installed: true,
          problems,
          detail:
            "The schema is incomplete, which is what a chat that accepts no messages usually turns out to be. Re-run the migration that creates each item below; they are all guarded, so re-running is safe.",
        };
  } catch (error) {
    return {
      ok: true,
      installed: false,
      problems: [],
      detail: `Could not reach the database, so the schema was not checked: ${String(error)}`,
    };
  }
}

type Check = {
  name: string;
  set: boolean;
  /** Which spelling actually supplied the value. */
  from?: string;
  /** Every accepted spelling — printed when nothing is set. */
  accepts?: string[];
  detail?: string;
};

function check(label: string, names: string[], value: string | undefined, detail?: string): Check {
  const source = names.find((name) => {
    const candidate = process.env[name];
    return typeof candidate === "string" && candidate.trim() !== "";
  });
  return {
    name: label,
    set: Boolean(value),
    ...(source ? { from: source } : { accepts: names }),
    ...(detail ? { detail } : {}),
  };
}

/**
 * One row per resolved address, because an address that is subtly wrong, a
 * multi-line paste, a typo, a domain that is not the verified one, fails in a
 * way nothing else on this page would show.
 */
function mailAddressChecks(): Check[] {
  const domain = env(["MAIL_DOMAIN"]);
  const rows: { label: string; names: string[]; value: string }[] = [
    { label: "Mail from", names: ["MAIL_FROM"], value: MAIL_FROM },
    { label: "Mail reply-to", names: ["MAIL_REPLY_TO"], value: MAIL_REPLY_TO },
    {
      label: "Mail notify-to",
      names: ["MAIL_NOTIFY_TO", "NOTIFY_TO", "STAFF_EMAIL"],
      value: MAIL_NOTIFY_TO,
    },
  ];

  return rows.map(({ label, names, value }) => {
    const issue = mailAddressIssue(value);
    const address = bareAddress(value);
    const source = names.find((name) => {
      const candidate = process.env[name];
      return typeof candidate === "string" && candidate.trim() !== "";
    });

    const notes: string[] = [value];
    if (issue) notes.push(`BROKEN: ${names[0]} ${issue}`);
    if (!source) notes.push("defaulted, not set explicitly");
    if (domain && !issue && !address.endsWith(`@${domain}`) && label === "Mail from") {
      notes.push(
        `not on MAIL_DOMAIN (${domain}), so Resend will reject it unless that domain is verified too`,
      );
    }
    if (domain && !issue && address.endsWith(`@${domain}`) && label === "Mail notify-to") {
      notes.push(
        `on MAIL_DOMAIN, so check it does not forward into /api/inbound-email or notifications will loop`,
      );
    }

    return {
      name: label,
      set: !issue,
      ...(source ? { from: source } : { accepts: names }),
      detail: notes.join(" — "),
    };
  });
}

/** One line on whether mail will actually go out. */
function mailSummary(): string {
  const problems: string[] = [];
  if (!env(["MAIL_DOMAIN"])) {
    problems.push("MAIL_DOMAIN is unset, so every send is rejected");
  }
  for (const [name, value] of [
    ["MAIL_FROM", MAIL_FROM],
    ["MAIL_REPLY_TO", MAIL_REPLY_TO],
    ["MAIL_NOTIFY_TO", MAIL_NOTIFY_TO],
  ] as const) {
    const issue = mailAddressIssue(value);
    if (issue) problems.push(`${name} ${issue}`);
  }
  if (!RESEND_API_KEY) problems.push("RESEND_API_KEY is unset, so nothing is sent at all");
  if (problems.length === 0)
    return "ok, as far as configuration goes; only a real send proves delivery";
  return `BROKEN: ${problems.join("; ")}`;
}

type ProbeStep = { step: string; ok: boolean; detail: string };

/**
 * Perform the exact write a visitor's chat makes, under the browser's own key.
 *
 * Every other check here runs with the service role, which bypasses RLS and so
 * cannot see any of the reasons a visitor's message gets refused. Three
 * separate causes produce the same sentence in the widget, and telling them
 * apart has meant reading a browser console: a missing policy, a missing grant,
 * and anonymous sign-ins being switched off. This signs in the way the widget
 * does and writes the way the widget does, so the answer comes back named.
 *
 * Not run unless asked for, because it writes two rows. They are deleted again
 * with the service role, and the conversation is labelled so an interrupted run
 * is recognisable in the dashboard.
 */
async function probeChatWrite(): Promise<{ ok: boolean; detail: string; steps: ProbeStep[] }> {
  const steps: ProbeStep[] = [];
  const add = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail });
    return ok;
  };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      ok: false,
      detail: "Supabase is not configured, so the visitor path could not be tried.",
      steps,
    };
  }

  const { createClient } = await import("@supabase/supabase-js");
  const visitor = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let sessionId: string | null = null;
  try {
    const signIn = await visitor.auth.signInAnonymously();
    if (signIn.error || !signIn.data.user) {
      add(
        "sign in anonymously",
        false,
        `${signIn.error?.message ?? "no user returned"}. Anonymous sign-ins are switched off for this project: turn them on under Authentication → Sign In / Providers.`,
      );
      return { ok: false, detail: "A visitor cannot sign in, so nothing else was tried.", steps };
    }
    add("sign in anonymously", true, `signed in as ${signIn.data.user.id}`);

    const session = await visitor
      .from("chat_sessions")
      .insert({ visitor_name: "Health check probe" })
      .select("id")
      .single();

    if (session.error) {
      add("open a conversation", false, explainRefusal(session.error, "chat_sessions", "insert"));
      return { ok: false, detail: "A visitor cannot open a conversation.", steps };
    }
    sessionId = String(session.data["id"]);
    add("open a conversation", true, "the row was accepted");

    const message = await visitor
      .from("chat_messages")
      .insert({ session_id: sessionId, sender: "visitor", body: "Health check probe." })
      .select("id")
      .single();

    if (message.error) {
      add("send a message", false, explainRefusal(message.error, "chat_messages", "insert"));
      return {
        ok: false,
        detail: "A visitor can open a conversation but cannot send a message.",
        steps,
      };
    }
    add("send a message", true, "the message was accepted");

    const readBack = await visitor.from("chat_messages").select("id").eq("session_id", sessionId);
    add(
      "read the conversation back",
      !readBack.error && (readBack.data?.length ?? 0) > 0,
      readBack.error
        ? explainRefusal(readBack.error, "chat_messages", "select")
        : `${readBack.data?.length ?? 0} message(s) visible to the visitor`,
    );

    return {
      ok: steps.every((entry) => entry.ok),
      detail: "A visitor can hold a conversation.",
      steps,
    };
  } catch (error) {
    add("unexpected", false, String(error));
    return { ok: false, detail: "The probe itself failed.", steps };
  } finally {
    // Tidy up with the service role, which is not subject to the policies
    // being tested. Cascade takes the messages with the session.
    if (sessionId && SERVICE_ROLE_KEY) {
      try {
        const { adminClient } = await import("./_shared.server");
        await adminClient().from("chat_sessions").delete().eq("id", sessionId);
      } catch {
        steps.push({
          step: "clean up",
          ok: false,
          detail: `The probe's conversation ${sessionId} could not be deleted; remove it from the dashboard.`,
        });
      }
    }
  }
}

/** Turn a refusal into the thing that actually needs fixing. */
export function explainRefusal(
  error: { message: string; code?: string; hint?: string },
  table: string,
  action: string,
): string {
  const code = error.code ?? "";
  if (/permission denied/i.test(error.message)) {
    return `${error.message} — this is a missing GRANT, not a policy. 0001_init.sql grants ${action} on ${table} to authenticated.`;
  }
  if (code === "42501" || /row-level security/i.test(error.message)) {
    return `${error.message} — this is a missing POLICY. The schema section above names it; 0001_init.sql restores it.`;
  }
  if (/jwt|token/i.test(error.message)) {
    return `${error.message} — the visitor's session was rejected, which is an auth problem rather than a schema one.`;
  }
  return `${error.message}${error.hint ? ` (hint: ${error.hint})` : ""}${code ? ` [${code}]` : ""}`;
}

export async function handleHealthCheck(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Use GET." }, 405);
  }

  const webhookSecretDetail = describeWebhookSecret(RESEND_WEBHOOK_SECRET);

  const checks: Check[] = [
    check("Supabase URL", SUPABASE_URL_NAMES, SUPABASE_URL, SUPABASE_URL),
    check("Supabase anon key", SUPABASE_ANON_KEY_NAMES, SUPABASE_ANON_KEY),
    check("Supabase service role key", SERVICE_ROLE_KEY_NAMES, SERVICE_ROLE_KEY),
    check(
      "Resend API key",
      RESEND_API_KEY_NAMES,
      RESEND_API_KEY,
      RESEND_API_KEY
        ? undefined
        : "unset — notification mail is skipped, everything else still works",
    ),
    check(
      "Resend webhook secret",
      RESEND_WEBHOOK_SECRET_NAMES,
      RESEND_WEBHOOK_SECRET,
      webhookSecretDetail,
    ),
    check(
      "Mail domain",
      ["MAIL_DOMAIN"],
      env(["MAIL_DOMAIN"]),
      env(["MAIL_DOMAIN"])
        ? undefined
        : `UNSET, so mail is sent from ${MAIL_FROM} and Resend will reject every send. Set MAIL_DOMAIN to the domain you verified in Resend.`,
    ),
    ...mailAddressChecks(),
  ];

  // Chat and the dashboard need Supabase; mail is optional.
  const required = checks.slice(0, 3);
  const missing = required.filter((entry) => !entry.set);

  // Whether visitor messages are actually landing in the database. This is the
  // one thing that separates "chat is broken" into a write problem or a read
  // problem, and it cannot be answered from the browser.
  const [chat, schema, email] = await Promise.all([inspectChat(), inspectSchema(), inspectEmail()]);

  // Opt-in, because it writes two rows and deletes them again.
  const wantsProbe = new URL(request.url).searchParams.get("probe") === "chat";
  const probe = wantsProbe ? await probeChatWrite() : undefined;

  return json(
    {
      status: missing.length === 0 && schema.ok ? "ok" : "misconfigured",
      // `status` is about whether the site works; mail is separate, because a
      // studio can be serving pages perfectly while every notification bounces.
      mail: mailSummary(),
      schema,
      chat,
      email,
      ...(probe
        ? { probe }
        : {
            probeHint:
              "Add ?probe=chat to run the exact write a visitor makes, under the browser's key, and have the failing step named. It writes two rows and deletes them again.",
          }),
      supabaseProject: SUPABASE_URL ?? null,
      mailDomain: MAIL_DOMAIN,
      missing: missing.map((entry) => ({ name: entry.name, setAnyOf: entry.accepts ?? [] })),
      checks,
      hint: "Set these in Vercel → Settings → Environment Variables (Production and Preview), then redeploy. Anonymous sign-ins must be enabled on the Supabase project printed above, under Authentication → Sign In / Providers.",
    },
    missing.length === 0 && schema.ok ? 200 : 503,
  );
}
