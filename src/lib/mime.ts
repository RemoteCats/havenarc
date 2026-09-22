// Pulling a readable body out of a raw MIME message.
//
// Some inbound webhooks hand over the whole RFC 822 message rather than parsed
// `text` and `html` fields, sometimes base64-encoded. This is not a general MIME
// parser and does not try to be: it walks the multipart boundaries far enough to
// find a text/plain or text/html part, decodes the two transfer encodings that
// actually occur, and gives up cleanly rather than guessing.
//
// No imports on purpose: the browser pulls this in through the dashboard.

export type MimeBody = { text: string; html: string };

const EMPTY: MimeBody = { text: "", html: "" };

function decodeQuotedPrintable(input: string): string {
  // `=C3=A9` is two UTF-8 bytes, not two code points, so collect bytes and
  // decode once. Doing it per-escape turns é into Ã©.
  const withoutSoftBreaks = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const char = withoutSoftBreaks[i]!;
    const hex = char === "=" ? withoutSoftBreaks.slice(i + 1, i + 3) : "";
    if (hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
}

function decodeBase64(input: string): string {
  try {
    const cleaned = input.replace(/\s+/g, "");
    if (cleaned === "") return "";
    const bytes =
      typeof Buffer !== "undefined"
        ? Buffer.from(cleaned, "base64")
        : Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes as Uint8Array);
  } catch {
    return "";
  }
}

function decodePart(body: string, encoding: string): string {
  const how = encoding.trim().toLowerCase();
  if (how === "base64") return decodeBase64(body);
  if (how === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

/** Split a part into its header block and its body. */
function splitPart(part: string): { headers: string; body: string } {
  const match = /\r?\n\r?\n/.exec(part);
  if (!match || match.index === undefined) return { headers: part, body: "" };
  return { headers: part.slice(0, match.index), body: part.slice(match.index + match[0].length) };
}

function headerOf(headers: string, name: string): string {
  // Unfold continuation lines before matching, or a wrapped Content-Type is missed.
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const found = new RegExp(`^${name}\\s*:\\s*(.*)$`, "im").exec(unfolded);
  return found?.[1]?.trim() ?? "";
}

/**
 * The text/plain and text/html parts of a raw MIME message.
 *
 * Returns empty strings for anything it cannot make sense of, so the caller can
 * fall through to whatever else it knows rather than showing wreckage.
 */
export function parseMime(raw: unknown, depth = 0): MimeBody {
  if (typeof raw !== "string" || raw.trim() === "" || depth > 4) return EMPTY;

  // A whole message handed over base64-encoded, which is common enough.
  if (!/[:\n]/.test(raw.slice(0, 200)) && /^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 200))) {
    const decoded = decodeBase64(raw);
    if (decoded && /content-type|^from:|^subject:/im.test(decoded))
      return parseMime(decoded, depth + 1);
  }

  const { headers, body } = splitPart(raw);
  // Keep the header as written for the boundary, which is case-sensitive, and
  // lowercase only for comparing the media type.
  const contentTypeRaw = headerOf(headers, "content-type");
  const contentType = contentTypeRaw.toLowerCase();
  const encoding = headerOf(headers, "content-transfer-encoding");

  if (contentType.startsWith("multipart/")) {
    const boundary = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentTypeRaw)?.[1]?.trim();
    if (!boundary) return EMPTY;

    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const out: MimeBody = { text: "", html: "" };
    for (const part of parts) {
      if (part.trim() === "" || part.trim() === "--") continue;
      const inner = parseMime(part.replace(/^\r?\n/, ""), depth + 1);
      // The last alternative wins for html, the first for text, which is how
      // mail clients generally treat multipart/alternative.
      if (inner.text && !out.text) out.text = inner.text;
      if (inner.html) out.html = inner.html;
    }
    return out;
  }

  const decoded = decodePart(body, encoding);
  if (contentType.startsWith("text/html")) return { text: "", html: decoded.trim() };
  if (contentType.startsWith("text/plain") || contentType === "") {
    return { text: decoded.trim(), html: "" };
  }
  return EMPTY;
}
