// Server route handler for POST /api/inbound-email — Resend's inbound webhook.
// Server-only: it reads the signing secret and writes with the service role.

import {
  adminClient,
  errorMessage,
  isEmail,
  json,
  normaliseSubject,
  parseAddress,
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
    console.warn("[inbound-email] rejected delivery:", verification.reason);
    return json({ error: "Invalid signature.", reason: verification.reason }, 401);
  }

  let payload: InboundPayload;
  try {
    payload = JSON.parse(rawBody) as InboundPayload;
  } catch {
    return json({ error: "Body is not JSON." }, 400);
  }

  if (payload.type !== "email.received") {
    // Delivery/bounce/open events share the endpoint. Acknowledge and drop.
    return json({ ignored: true, type: String(payload.type ?? "") });
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
      body_text: text(mail.text, 100000) || null,
      body_html: typeof mail.html === "string" ? mail.html.slice(0, 200000) : null,
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
