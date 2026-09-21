// Run with:  node --experimental-strip-types --no-warnings scripts/inbound-email.test.mts
//
// Drives the real handleInboundEmail() through a correctly signed Resend
// delivery, with a stand-in for the Supabase REST API, and through every way a
// delivery gets dropped. Answers the question "is the code the reason mail is
// not arriving?" without needing a Supabase project.
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type ViteDevServer } from "vite";

// The handler imports "./_shared.server" without an extension, which only a
// bundler resolves, so load it through Vite's SSR pipeline rather than bare
// Node. That also means this exercises the module graph the server really uses.
const HANDLER = "/src/lib/api/inbound-email.server.ts";
let vite: ViteDevServer;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, got = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${got ? "\n          " + got : ""}`); }
};

// --- a stand-in for PostgREST ---------------------------------------------
type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let threadExists = false;
let messageExists = false;
let threadInsertFails: string | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.includes("stub.supabase.co")) return realFetch(input, init);
  const method = init?.method ?? "GET";
  const path = url.replace(/^https:\/\/stub\.supabase\.co/, "");
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });

  const reply = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  if (path.startsWith("/rest/v1/email_messages") && method === "GET")
    return reply(messageExists ? [{ id: "existing", thread_id: "t-old" }] : []);
  if (path.startsWith("/rest/v1/email_threads") && method === "GET")
    return reply(threadExists ? [{ id: "t-1" }] : []);
  if (path.startsWith("/rest/v1/email_threads") && method === "POST")
    return threadInsertFails
      ? reply({ message: threadInsertFails, code: "42P01" }, 400)
      : reply([{ id: "t-new" }], 201);
  if (path.startsWith("/rest/v1/email_messages") && method === "POST")
    return reply([{ id: "m-new" }], 201);
  return reply([]);
}) as typeof fetch;

const KEY = Buffer.from("a-signing-key-that-is-32-bytes!!", "utf8");
const SECRET = "whsec_" + KEY.toString("base64");

function signed(body: string, secret = KEY) {
  const id = `msg_${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000).toString();
  return new Headers({
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": "v1," + createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64"),
  });
}

async function loadHandler(env: Record<string, string>) {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    RESEND_WEBHOOK_SECRET: SECRET,
    ...env,
  });
  // The env is read at module load, so every scenario needs a fresh graph.
  vite.moduleGraph.invalidateAll();
  return vite.ssrLoadModule(HANDLER);
}

vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  configFile: false,
  resolve: { alias: { "@": new URL("../src", import.meta.url).pathname } },
});

const delivery = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "email.received",
    data: {
      email_id: "re_inbound_1",
      from: "Someone Outside <someone@example.com>",
      to: ["frontdesk@meastroarchitecture.com"],
      subject: "Re: A question about a site",
      text: "Is the studio taking on work in Rochester?",
      html: "<p>Is the studio taking on work in Rochester?</p>",
      headers: [
        { name: "Message-Id", value: "<abc123@mail.example.com>" },
        { name: "Subject", value: "Re: A question about a site" },
      ],
      attachments: [],
      ...over,
    },
  });

const post = (mod: any, body: string, headers = signed(body)) =>
  mod.handleInboundEmail(new Request("https://site.test/api/inbound-email", { method: "POST", body, headers }));

console.log("\n1. A correctly signed delivery is filed\n");
{
  const mod = await loadHandler({});
  calls = []; threadExists = false; messageExists = false;
  const body = delivery();
  const res = await post(mod, body);
  const out = await res.json();
  ok("returns 200", res.status === 200, `status ${res.status} ${JSON.stringify(out)}`);
  ok("reports the thread it filed into", Boolean(out.threadId), JSON.stringify(out));

  const threadInsert = calls.find((c) => c.method === "POST" && c.path.includes("email_threads"));
  const messageInsert = calls.find((c) => c.method === "POST" && c.path.includes("email_messages"));
  ok("opens a thread", Boolean(threadInsert));
  ok("files the sender, not the recipient", (threadInsert?.body as any)?.participant_email === "someone@example.com",
     JSON.stringify(threadInsert?.body));
  ok("strips Re: for threading", (threadInsert?.body as any)?.subject === "A question about a site",
     JSON.stringify((threadInsert?.body as any)?.subject));
  const m = messageInsert?.body as any;
  ok("marks the message inbound", m?.direction === "inbound", JSON.stringify(m?.direction));
  ok("keeps the real Message-Id for dedupe", m?.message_id === "<abc123@mail.example.com>", JSON.stringify(m?.message_id));
  ok("records who it was sent to", m?.to_email === "frontdesk@meastroarchitecture.com", JSON.stringify(m?.to_email));
  ok("keeps the original subject on the message", m?.subject === "Re: A question about a site", JSON.stringify(m?.subject));
  ok("carries the body", m?.body_text?.includes("Rochester"), JSON.stringify(m?.body_text));
}

console.log("\n2. A retry of the same delivery is not filed twice\n");
{
  const mod = await loadHandler({});
  calls = []; messageExists = true;
  const res = await post(mod, delivery());
  const out = await res.json();
  ok("returns 200 so Resend stops retrying", res.status === 200);
  ok("reports it as a duplicate", out.deduped === true, JSON.stringify(out));
  ok("writes nothing", !calls.some((c) => c.method === "POST"), JSON.stringify(calls.map((c) => c.method + " " + c.path)));
  messageExists = false;
}

console.log("\n3. Deliveries that are dropped, and why\n");
{
  const mod = await loadHandler({});
  for (const [name, type] of [["a delivery receipt", "email.delivered"], ["a bounce", "email.bounced"], ["an open", "email.opened"]] as [string, string][]) {
    calls = [];
    const body = JSON.stringify({ type, data: {} });
    const res = await post(mod, body);
    const out = await res.json();
    ok(`${name} is acknowledged and ignored`, res.status === 200 && out.ignored === true, JSON.stringify(out));
  }

  const badFrom = await post(mod, delivery({ from: "" }));
  ok("a delivery with no usable sender is refused with a reason",
     badFrom.status === 400 && /sender/i.test((await badFrom.json()).error), String(badFrom.status));

  threadInsertFails = 'relation "public.email_threads" does not exist';
  calls = [];
  const noTables = await post(mod, delivery({ headers: [] }));
  const noTablesBody = await noTables.json();
  ok("a missing table surfaces as a 500 naming the relation",
     noTables.status === 500 && /email_threads/.test(noTablesBody.error), JSON.stringify(noTablesBody));
  console.log(`          Resend's log would show: ${JSON.stringify(noTablesBody.error)}`);
  threadInsertFails = null;
}

console.log("\n4. A rejected signature explains itself in Resend's log\n");
{
  const mod = await loadHandler({});
  const body = delivery();
  const wrong = await post(mod, body, signed(body, Buffer.from("a-completely-different-key-32byt", "utf8")));
  const out = await wrong.json();
  ok("returns 401", wrong.status === 401);
  ok("says the signature did not match", /signature/i.test(out.error + out.reason), JSON.stringify(out));
  ok("names the variable to change", /RESEND_WEBHOOK_SECRET/.test(out.fix), JSON.stringify(out.fix));

  const apiKeyInSlot = await loadHandler({ RESEND_WEBHOOK_SECRET: "re_ABC123def456GHI789jkl" });
  const b2 = delivery();
  const res2 = await post(apiKeyInSlot, b2, signed(b2));
  const out2 = await res2.json();
  ok("an API key pasted into the secret slot is named as such",
     res2.status === 401 && /Resend API key/.test(out2.secret), JSON.stringify(out2.secret));
  console.log(`          Resend's log would show: ${JSON.stringify(out2.secret)}`);

  const noSecret = await loadHandler({ RESEND_WEBHOOK_SECRET: "" });
  const b3 = delivery();
  const res3 = await post(noSecret, b3, signed(b3));
  ok("an unset secret rejects rather than accepting anything", res3.status === 401);
}

console.log("\n5. Only POST is accepted\n");
{
  const mod = await loadHandler({});
  const res = await mod.handleInboundEmail(new Request("https://site.test/api/inbound-email", { method: "GET" }));
  ok("a GET is refused with 405", res.status === 405);
}

await vite.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
