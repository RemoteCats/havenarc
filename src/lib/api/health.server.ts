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

    return {
      reachable: true,
      detail:
        (messages.count ?? 0) > 0
          ? "Visitor messages are reaching the database. If the dashboard is not showing them, the problem is on the read side — the widget and dashboard now poll as well as subscribe, so reload both."
          : "No chat messages stored yet. If a visitor has sent one, the write is failing — check that anonymous sign-ins are enabled on this project.",
      sessions: sessions.count ?? 0,
      messages: messages.count ?? 0,
      latestMessageAt: (latest.data?.["created_at"] as string | undefined) ?? null,
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

  return json(
    {
      status: missing.length === 0 && schema.ok ? "ok" : "misconfigured",
      // `status` is about whether the site works; mail is separate, because a
      // studio can be serving pages perfectly while every notification bounces.
      mail: mailSummary(),
      schema,
      chat,
      email,
      supabaseProject: SUPABASE_URL ?? null,
      mailDomain: MAIL_DOMAIN,
      missing: missing.map((entry) => ({ name: entry.name, setAnyOf: entry.accepts ?? [] })),
      checks,
      hint: "Set these in Vercel → Settings → Environment Variables (Production and Preview), then redeploy. Anonymous sign-ins must be enabled on the Supabase project printed above, under Authentication → Sign In / Providers.",
    },
    missing.length === 0 && schema.ok ? 200 : 503,
  );
}
