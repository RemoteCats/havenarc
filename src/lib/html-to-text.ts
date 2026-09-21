// Shared by the inbound webhook and the dashboard, so it can live in neither.
// No imports on purpose: the browser pulls this in, and `_shared.server.ts`
// carries the service-role key.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#160": " ",
};

/**
 * A readable plain-text rendering of an HTML email body.
 *
 * Not a general HTML parser and not trying to be. Mail arrives HTML-only often
 * enough that a dashboard showing "(no plain-text body)" is showing nothing
 * when it holds the whole message, and the reader wants the words, not the
 * markup. Script and style contents are dropped rather than flattened into the
 * text, block-level tags become line breaks so paragraphs survive, and the
 * result is plain text: it is never inserted as HTML anywhere.
 */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string" || html.trim() === "") return "";

  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&([a-z]+|#x?[0-9a-f]+);/gi, (match, name: string) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key]!;
      const numeric = /^#x([0-9a-f]+)$/i.exec(key) ?? /^#(\d+)$/.exec(key);
      if (numeric?.[1]) {
        const code = key.startsWith("#x") ? parseInt(numeric[1], 16) : Number(numeric[1]);
        if (Number.isFinite(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
      }
      return match;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
