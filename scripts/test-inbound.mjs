#!/usr/bin/env node
// Send one correctly signed email.received delivery to the live endpoint.
//
//   RESEND_WEBHOOK_SECRET=whsec_... node scripts/test-inbound.mjs https://your-site.com
//
// Or straight from the deployment, which is the version worth trusting:
//
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/test-inbound.mjs https://your-site.com
//
// This is the decisive test. It bypasses Resend entirely and speaks to the
// endpoint the way Resend would, so the answer separates two things that look
// identical from the dashboard:
//
//   200 and a thread appears  -> the endpoint, the secret and the database are
//                                all fine, and the only thing left is that
//                                Resend is not calling it. Check that a webhook
//                                subscribed to email.received points here.
//   anything else             -> the response says which part is wrong.
//
// Nothing is printed that would expose the secret.

import { createHmac, randomUUID } from "node:crypto";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("Usage: node scripts/test-inbound.mjs https://your-deployment.example.com");
  process.exit(2);
}

const secret = (
  process.env["RESEND_WEBHOOK_SECRET"] ??
  process.env["RESEND_SIGNING_SECRET"] ??
  ""
).trim();
if (!secret) {
  console.error(
    "RESEND_WEBHOOK_SECRET is not set in this shell. Pull it from the deployment:\n  vercel env pull .env.local && node --env-file=.env.local scripts/test-inbound.mjs " +
      base,
  );
  process.exit(2);
}
if (secret.startsWith("re_")) {
  console.error(
    "RESEND_WEBHOOK_SECRET holds a Resend API key. The signing secret starts whsec_ and is on the webhook in Resend, not the API keys page.",
  );
  process.exit(2);
}

const url = `${base}/api/inbound-email`;
const marker = randomUUID().slice(0, 8);
const body = JSON.stringify({
  type: "email.received",
  data: {
    email_id: `test_${marker}`,
    from: `Endpoint Test <inbound-test+${marker}@example.com>`,
    to: [process.env["MAIL_NOTIFY_TO"] ?? "frontdesk@example.com"],
    subject: `Inbound endpoint test ${marker}`,
    text: `Sent by scripts/test-inbound.mjs at ${new Date().toISOString()}. Safe to delete.`,
    html: `<p>Sent by <code>scripts/test-inbound.mjs</code>. Safe to delete.</p>`,
    headers: [{ name: "Message-Id", value: `<inbound-test-${marker}@example.com>` }],
    attachments: [],
  },
});

// Exactly how Resend signs it: HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`.
const id = `msg_${randomUUID()}`;
const timestamp = Math.floor(Date.now() / 1000).toString();
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
const signature =
  "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

console.log(`\nPOST ${url}`);
console.log(`  subject: Inbound endpoint test ${marker}\n`);

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
    body,
  });
} catch (error) {
  console.error(`Could not reach the endpoint: ${error.message}`);
  console.error("Check the URL, and that the deployment is live.");
  process.exit(1);
}

const text = await res.text();
let parsed = null;
try {
  parsed = JSON.parse(text);
} catch {
  /* not JSON */
}

console.log(`  ${res.status} ${res.statusText}`);
console.log(
  "  " + (parsed ? JSON.stringify(parsed, null, 2).replace(/\n/g, "\n  ") : text.slice(0, 500)),
);
console.log();

if (res.status === 200 && parsed?.ok) {
  console.log(
    `The endpoint filed it. Open /admin → Email and look for "Inbound endpoint test ${marker}".`,
  );
  console.log();
  console.log(
    "  It is there      -> the whole path works, and Resend simply is not calling this URL.",
  );
  console.log(
    "                      In Resend, check a webhook subscribed to email.received points at",
  );
  console.log(`                      ${url}`);
  console.log(
    "                      Receiving mail and forwarding it to a webhook are two separate",
  );
  console.log("                      settings; the first can work while the second is missing.");
  console.log();
  console.log(
    "  It is NOT there  -> the row was written but the dashboard cannot read it, which is an",
  );
  console.log(
    "                      admin SELECT policy. Run supabase/verify.sql, or read the `schema`",
  );
  console.log("                      section of /api/health, and re-run 0002_email.sql.");
} else if (res.status === 404) {
  console.log(
    "No such endpoint on this deployment. Either the URL is wrong, or the deployment predates it.",
  );
} else if (res.status === 401) {
  console.log(
    "The signature was rejected, so the secret here differs from the one the deployment holds.",
  );
  console.log("Both must be the whsec_ value from the webhook in Resend.");
} else if (res.status === 500) {
  console.log(
    "The endpoint ran but could not write. The reason above names the relation; it is usually",
  );
  console.log("supabase/migrations/0002_email.sql not having been applied.");
}
console.log();
process.exit(res.status === 200 ? 0 : 1);
