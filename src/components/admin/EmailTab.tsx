import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";

import { useRealtimeRows } from "@/hooks/useRealtimeRows";
import { sendEmailReply } from "@/lib/api/email";
import { ITEM_STATUSES, type EmailMessage, type EmailThread } from "@/lib/database.types";
import { htmlToText } from "@/lib/html-to-text";
import { readableError } from "@/lib/readable-error";

import {
  EmptyState,
  ListDetail,
  ListRow,
  PanelError,
  StatusSelect,
  formatWhen,
} from "./primitives";

/**
 * What to print for a message body.
 *
 * Plenty of mail is HTML-only, and a message stored with `body_html` and no
 * `body_text` used to render as "(no plain-text body)" while holding the entire
 * message. Falling back to a text rendering of the HTML shows the words. The
 * result is inserted as text, never as HTML, so nothing from an email is ever
 * parsed as markup in the dashboard.
 */
function readableBody(message: EmailMessage): string {
  const plain = message.body_text?.trim();
  if (plain) return plain;
  const fromHtml = htmlToText(message.body_html).trim();
  if (fromHtml) return fromHtml;
  return "(this message arrived with no body)";
}

export function EmailTab({ enabled }: { enabled: boolean }) {
  const { rows, loading, error } = useRealtimeRows<EmailThread>("email_threads", {
    orderBy: "last_message_at",
    enabled,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;

  // 0002_email.sql is optional. Say so rather than showing an empty list.
  const migrationMissing = error !== null && /email_threads/.test(error);

  return (
    <div className="space-y-4">
      {migrationMissing ? (
        <PanelError message="Email threads are not set up on this project. Apply supabase/migrations/0002_email.sql, then point a Resend inbound route at /api/inbound-email." />
      ) : (
        <PanelError message={error} />
      )}
      <ListDetail
        list={
          loading ? (
            <EmptyState>Loading threads…</EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState>No email threads yet.</EmptyState>
          ) : (
            rows.map((row) => (
              <ListRow
                key={row.id}
                active={selected?.id === row.id}
                onSelect={() => setSelectedId(row.id)}
                title={row.participant_name || row.participant_email}
                subtitle={row.subject || "(no subject)"}
                meta={formatWhen(row.last_message_at)}
                status={row.status}
              />
            ))
          )
        }
        detail={
          selected ? (
            <Thread key={selected.id} thread={selected} enabled={enabled} />
          ) : (
            <EmptyState>Select a thread.</EmptyState>
          )
        }
      />
    </div>
  );
}

function Thread({ thread, enabled }: { thread: EmailThread; enabled: boolean }) {
  const { rows: messages, error } = useRealtimeRows<EmailMessage>("email_messages", {
    orderBy: "created_at",
    ascending: true,
    enabled,
    filter: { column: "thread_id", value: thread.id },
  });

  const reply = useServerFn(sendEmailReply);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setSendError(null);
    void (async () => {
      try {
        await reply({ data: { threadId: thread.id, body } });
        setDraft("");
      } catch (caught) {
        setSendError(readableError(caught));
      } finally {
        setSending(false);
      }
    })();
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-6">
        <div className="min-w-0">
          <h3 className="truncate font-display text-2xl">{thread.subject || "(no subject)"}</h3>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {thread.participant_name ? `${thread.participant_name} · ` : ""}
            {thread.participant_email}
          </p>
        </div>
        <StatusSelect
          table="email_threads"
          id={thread.id}
          value={thread.status}
          options={ITEM_STATUSES}
        />
      </div>

      <PanelError message={error ?? sendError} />

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages filed on this thread.</p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`border-l-2 px-4 py-3 ${
                message.direction === "outbound"
                  ? "border-accent bg-secondary/60"
                  : "border-border bg-background"
              }`}
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {message.direction === "outbound" ? "Sent" : "Received"} ·{" "}
                  {message.from_name || message.from_email}
                </span>
                <span>{formatWhen(message.created_at)}</span>
              </header>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                {readableBody(message)}
              </p>
              {message.has_attachments ? (
                <p className="mt-2 text-xs text-muted-foreground">Has attachments.</p>
              ) : null}
            </article>
          ))
        )}
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-3 border-t border-border p-4">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          maxLength={20000}
          placeholder={`Reply to ${thread.participant_email}`}
          aria-label="Reply"
          className="min-w-0 flex-1 resize-none border-b border-border bg-transparent px-1 py-2 text-sm outline-none transition-colors focus:border-accent"
        />
        <button
          type="submit"
          disabled={sending || draft.trim() === ""}
          className="eyebrow shrink-0 bg-primary px-5 py-3 text-primary-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
        >
          {sending ? "Sending…" : "Reply"}
        </button>
      </form>
    </div>
  );
}
