// Run with:  node --experimental-strip-types --no-warnings scripts/email-body.test.mts
//
// Mail arrived and filed, but the dashboard printed "(no plain-text body)".
// Two causes, both covered here: the body not being where the route looked,
// and the dashboard only ever reading body_text when the message was HTML.
import { htmlToText } from "../src/lib/html-to-text.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, got = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${got ? "\n          got: " + JSON.stringify(got) : ""}`); }
};

console.log("\n1. Turning an HTML email into something readable\n");
{
  const gmail = `<div dir="ltr">Hi there,<br><br>Is the studio taking on work in&nbsp;Rochester?<br><br>Thanks,<br>Someone</div>`;
  const out = htmlToText(gmail);
  ok("keeps the words", /Is the studio taking on work in Rochester\?/.test(out), out);
  ok("turns <br><br> into a paragraph break", /Hi there,\n\nIs the studio/.test(out), out);
  ok("decodes &nbsp;", !out.includes("&nbsp;"), out);
  console.log("        ->", JSON.stringify(out));
}
{
  const styled = `<html><head><style>.x{color:red}</style></head><body><p>First paragraph.</p><p>Second paragraph.</p></body></html>`;
  const out = htmlToText(styled);
  ok("drops stylesheet contents rather than printing them", !/color:red/.test(out), out);
  ok("keeps both paragraphs apart", /First paragraph\.\n\nSecond paragraph\./.test(out), out);
}
{
  const nasty = `<p>Before</p><script>alert('x')</script><p>After</p>`;
  const out = htmlToText(nasty);
  ok("drops script contents", !/alert/.test(out), out);
  ok("keeps the text either side", /Before/.test(out) && /After/.test(out), out);
  ok("leaves no tags behind", !/[<>]/.test(out), out);
}
{
  const list = `<ul><li>One</li><li>Two</li></ul>`;
  ok("marks list items", /• One/.test(htmlToText(list)) && /• Two/.test(htmlToText(list)), htmlToText(list));
}
{
  ok("entities decode", htmlToText("<p>Tom &amp; Jerry &lt;tom@x.com&gt;</p>") === "Tom & Jerry <tom@x.com>",
     htmlToText("<p>Tom &amp; Jerry &lt;tom@x.com&gt;</p>"));
  ok("numeric entities decode", htmlToText("<p>caf&#233;</p>") === "café", htmlToText("<p>caf&#233;</p>"));
  ok("an empty body stays empty", htmlToText("") === "" && htmlToText(null) === "" && htmlToText(undefined) === "");
  ok("whitespace-only html is empty", htmlToText("<div>   </div>") === "", htmlToText("<div>   </div>"));
}

console.log("\n2. Finding the body wherever the provider put it\n");
{
  const { pickBody } = await import("../src/lib/api/_shared.server.ts");
  const cases: [string, Record<string, unknown>, string][] = [
    ["text", { text: "plain words" }, "plain words"],
    ["html only", { html: "<p>from the html</p>" }, "from the html"],
    ["text wins over html", { text: "plain", html: "<p>markup</p>" }, "plain"],
    ["plain", { plain: "under plain" }, "under plain"],
    ["text_body", { text_body: "under text_body" }, "under text_body"],
    ["body_text", { body_text: "under body_text" }, "under body_text"],
    ["nested under content", { content: { text: "nested" } }, "nested"],
    ["nested html under content", { content: { html: "<p>nested html</p>" } }, "nested html"],
    ["body as a bare string", { body: "just a string" }, "just a string"],
    ["empty strings are not a body", { text: "   ", html: "" }, ""],
    ["nothing at all", {}, ""],
  ];
  for (const [name, data, expected] of cases) {
    const got = pickBody(data).text;
    ok(`${name}`, got === expected, `${got} (wanted ${expected})`);
  }
  ok("html is kept alongside the text", pickBody({ html: "<p>x</p>" }).html === "<p>x</p>");
}

console.log("\n3. What the dashboard prints\n");
{
  const readable = (m: { body_text: string | null; body_html: string | null }) => {
    const plain = m.body_text?.trim();
    if (plain) return plain;
    const fromHtml = htmlToText(m.body_html).trim();
    if (fromHtml) return fromHtml;
    return "(this message arrived with no body)";
  };
  ok("plain text is printed as-is", readable({ body_text: "hello", body_html: null }) === "hello");
  ok("an HTML-only message is readable instead of '(no plain-text body)'",
     readable({ body_text: null, body_html: "<p>the actual message</p>" }) === "the actual message",
     readable({ body_text: null, body_html: "<p>the actual message</p>" }));
  ok("a genuinely empty message says so",
     readable({ body_text: null, body_html: null }) === "(this message arrived with no body)");
  ok("whitespace-only text falls through to the html",
     readable({ body_text: "   ", body_html: "<p>real</p>" }) === "real");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
