// Server route handler for POST /api/inbound-email — Resend's inbound webhook.
// Server-only: it reads the signing secret and writes with the service role.

import {
  RESEND_WEBHOOK_SECRET,
  adminClient,
  describeWebhookSecret,
  errorMessage,
  isEmail,
  json,
  normaliseSubject,
  parseAddress,
  pickBody,
  text,
  verifyResendWebhook,
} from "./_shared.server";

type Header = { name?: unknown; value?: unknown };

type InboundPayload = {
  type?: unknown;
  data?: {
    email_id?: unknown;
    id?: unknown;
    from?: unknown;
    to?: unknown;
    subject?: unknown;
    text?: unknown;
    html?: unknown;
    headers?: unknown;
    attachments?: unknown;
  };
};

function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  for (const entry of headers as Header[]) {
    if (typeof entry?.name === "string" && entry.name.toLowerCase() === name.toLowerCase()) {
      return typeof entry.value === "string" ? entry.value.trim() : null;
    }
  }
  return null;
}

function firstRecipient(to: unknown): string {
  if (Array.isArray(to)) return parseAddress(to[0]).email;
  return parseAddress(to).email;
}

export async function handleInboundEmail(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  // Read the raw body and verify the signature over exactly those bytes,
  // before parsing anything. A reparsed-and-restringified body will not match.
  const rawBody = await request.text();
  const verification = verifyResendWebhook(rawBody, request.headers);
  if (!verification.ok) {
    // Resend shows the response body in its webhook log, which is where
    // someone looks when mail is not arriving. Spend it on the likely cause
    // rather than on "invalid signature", which they can already see.
    const secret = describeWebhookSecret(RESEND_WEBHOOK_SECRET);
    console.warn("[inbound-email] rejected delivery:", verification.reason, "|", secret);
    return json(
      {
        error: "Invalid signature.",
        reason: verification.reason,
        secret,
        fix: "RESEND_WEBHOOK_SECRET on this deployment must be the whsec_ signing secret shown on this inbound endpoint in Resend, not an API key. Change it in Vercel → Settings → Environment Variables and redeploy.",
      },
      401,
    );
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(rawBody) as InboundPayload;
  } catch {
    return json({ error: "Body is not JSON." }, 400);
  }

  if (payload.type !== "email.received") {
    const type = String(payload.type ?? "");
    const body = payload.data ?? {};

    // A payload carrying a sender and a message body is inbound mail, whatever
    // the event is called. Dropping that silently is the worst failure this
    // route has: it answers 200, so Resend's log shows delivery after delivery
    // succeeding while nothing is ever filed, and every other check stays
    // green. Do not guess and file it, because an outbound receipt carries a
    // sender too and would land in the dashboard as a customer email. Say it
    // loudly enough that the delivery log explains itself instead.
    const looksInbound =
      isEmail(parseAddress(body.from).email) &&
      (typeof body.text === "string" || typeof body.html === "string");

    if (looksInbound) {
      console.warn(
        `[inbound-email] dropped what looks like real mail: this route files "email.received" and the event was "${type}".`,
      );
      return json({
        ignored: true,
        type,
        warning: `This looks like inbound mail but arrived as "${type}", and this route only files "email.received". Nothing was saved. If this is the event your inbound webhook sends, the route needs to accept it.`,
      });
    }

    // Delivery/bounce/open events share the endpoint. Acknowledge and drop.
    console.info(`[inbound-email] ignored event: ${type}`);
    return json({ ignored: true, type });
  }

  const mail = payload.data ?? {};
  const providerId = text(mail.email_id ?? mail.id, 200);
  const from = parseAddress(mail.from);

  if (!isEmail(from.email)) {
    return json({ error: `Unusable sender address on the event: ${from.email || "(none)"}` }, 400);
  }

  const headers = mail.headers;
  // Prefer the real RFC Message-Id; fall back to Resend's own id so dedupe and
  // threading still have a key.
  const messageId =
    headerValue(headers, "message-id") ?? (providerId ? `resend:${providerId}` : null);
  const inReplyTo = headerValue(headers, "in-reply-to");
  const body = pickBody(mail as Record<string, unknown>);
  if (!body.text && !body.html) {
    // Filing a message with no body is worse than useless: the dashboard shows
    // an empty conversation and there is nothing to say where the words went.
    // The key names are the provider's to choose, so print the ones that
    // arrived rather than guessing again.
    console.warn(
      `[inbound-email] no body on this delivery. The keys present were: ${Object.keys(mail).join(", ") || "(none)"}. If one of those holds the message, pickBody() in _shared.server.ts needs it.`,
    );
  }

  const rawSubject = text(mail.subject, 500);
  const subject = normaliseSubject(rawSubject);
  const attachments = mail.attachments;

  try {
    const db = adminClient();

    // Inbound webhooks retry. Filing the same mail twice would duplicate the
    // conversation, so check before writing (the unique index is the backstop).
    if (messageId) {
      const { data: existing } = await db
        .from("email_messages")
        .select("id")
        .eq("message_id", messageId)
        .maybeSingle();
      if (existing) return json({ deduped: true, messageId });
    }

    // Find the thread by correspondent + normalised subject, so a reply with
    // no In-Reply-To header still lands in the right conversation.
    let threadId: string | null = null;

    if (inReplyTo) {
      const { data: parent } = await db
        .from("email_messages")
        .select("thread_id")
        .eq("message_id", inReplyTo)
        .maybeSingle();
      if (parent) threadId = String(parent["thread_id"]);
    }

    if (!threadId) {
      const { data: existingThread } = await db
        .from("email_threads")
        .select("id")
        .ilike("participant_email", from.email)
        .ilike("subject", subject)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingThread) threadId = String(existingThread["id"]);
    }

    if (!threadId) {
      const { data: created, error: createError } = await db
        .from("email_threads")
        .insert({
          subject,
          participant_email: from.email,
          participant_name: from.name,
        })
        .select("id")
        .single();
      if (createError || !created) {
        throw new Error(`Could not open a thread: ${createError?.message ?? "no row returned"}`);
      }
      threadId = String(created["id"]);
    }

    const { error: insertError } = await db.from("email_messages").insert({
      thread_id: threadId,
      direction: "inbound",
      from_email: from.email,
      from_name: from.name,
      to_email: firstRecipient(mail.to) || null,
      subject: rawSubject || subject,
      body_text: text(body.text, 100000) || null,
      body_html: body.html ? body.html.slice(0, 200000) : null,
      message_id: messageId,
      in_reply_to: inReplyTo,
      has_attachments: Array.isArray(attachments) && attachments.length > 0,
    });

    if (insertError) {
      // A concurrent retry can win the race to the unique index. That is the
      // dedupe working, not a failure.
      if (insertError.code === "23505") return json({ deduped: true, messageId });
      throw new Error(`Could not file the message: ${insertError.message}`);
    }

    return json({ ok: true, threadId, messageId });
  } catch (error) {
    console.error("[inbound-email]", error);
    return json({ error: errorMessage(error) }, 500);
  }
}
