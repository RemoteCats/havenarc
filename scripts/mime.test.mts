// Run with:  node --experimental-strip-types --no-warnings scripts/mime.test.mts
//
// A message filed with an empty body. The words are somewhere in the payload;
// these are the shapes they could be in.
import { parseMime } from "../src/lib/mime.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, got = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${got ? "\n          got: " + JSON.stringify(got) : ""}`); }
};

const CRLF = "\r\n";
const msg = (lines: string[]) => lines.join(CRLF);

console.log("\n1. A plain-text message\n");
{
  const raw = msg([
    "From: someone@example.com",
    "Subject: HI",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Is the studio taking on work in Rochester?",
  ]);
  const out = parseMime(raw);
  ok("finds the text", out.text === "Is the studio taking on work in Rochester?", out.text);
  ok("no html", out.html === "");
}

console.log("\n2. multipart/alternative, as most mail clients send\n");
{
  const raw = msg([
    "Content-Type: multipart/alternative; boundary=\"XYZ\"",
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "the plain version",
    "--XYZ",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>the html version</p>",
    "--XYZ--",
  ]);
  const out = parseMime(raw);
  ok("finds the plain part", out.text === "the plain version", out.text);
  ok("finds the html part", out.html === "<p>the html version</p>", out.html);
}

console.log("\n3. Transfer encodings\n");
{
  const b64 = msg([
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("decoded from base64", "utf8").toString("base64"),
  ]);
  ok("base64 part decodes", parseMime(b64).text === "decoded from base64", parseMime(b64).text);

  const qp = msg([
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "caf=C3=A9 and a soft=",
    " break",
  ]);
  ok("quoted-printable decodes", /café/.test(parseMime(qp).text), parseMime(qp).text);
}

console.log("\n4. The whole message handed over base64-encoded\n");
{
  const inner = msg(["Content-Type: text/plain", "", "inside the envelope"]);
  const wrapped = Buffer.from(inner, "utf8").toString("base64");
  ok("unwraps and parses", parseMime(wrapped).text === "inside the envelope", parseMime(wrapped).text);
}

console.log("\n5. A folded Content-Type header\n");
{
  const raw = ["Content-Type: multipart/mixed;", "\tboundary=\"AAA\"", "", "--AAA",
    "Content-Type: text/plain", "", "found anyway", "--AAA--"].join(CRLF);
  ok("unfolds the header and still finds the part", parseMime(raw).text === "found anyway", parseMime(raw).text);
}

console.log("\n6. Nested multipart, text inside an alternative inside a mixed\n");
{
  const raw = msg([
    "Content-Type: multipart/mixed; boundary=\"OUT\"",
    "",
    "--OUT",
    "Content-Type: multipart/alternative; boundary=\"IN\"",
    "",
    "--IN",
    "Content-Type: text/plain",
    "",
    "buried but found",
    "--IN--",
    "--OUT--",
  ]);
  ok("walks down to it", parseMime(raw).text === "buried but found", parseMime(raw).text);
}

console.log("\n7. Things that must not produce wreckage\n");
{
  for (const [name, value] of [
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["not mime at all", "just some words with no headers"],
    ["multipart with no boundary", "Content-Type: multipart/mixed\r\n\r\nnothing"],
  ] as [string, unknown][]) {
    const out = parseMime(value);
    ok(`${name} returns empty strings`, out.text === "" || typeof out.text === "string", JSON.stringify(out));
    ok(`${name} never returns undefined`, typeof out.text === "string" && typeof out.html === "string");
  }
}

console.log("\n8. pickBody reaches into raw MIME only when nothing simpler works\n");
{
  const { pickBody } = await import("../src/lib/api/_shared.server.ts");
  const raw = msg(["Content-Type: text/plain", "", "from the raw message"]);
  ok("raw is used when text and html are absent", pickBody({ raw }).text === "from the raw message",
     pickBody({ raw }).text);
  ok("a parsed text field still wins", pickBody({ text: "parsed", raw }).text === "parsed",
     pickBody({ text: "parsed", raw }).text);
  ok("other raw key names are tried", pickBody({ raw_email: raw }).text === "from the raw message");
  ok("nothing anywhere is still empty", pickBody({ subject: "x" }).text === "");
}

console.log("\n9. A delivery with no body explains itself in the dashboard\n");
{
  const { describePayloadShape } = await import("../src/lib/api/_shared.server.ts");
  const out = describePayloadShape({
    email_id: "re_abc",
    from: "someone@example.com",
    attachments: [1, 2],
    headers: [{ name: "Message-Id" }],
    unexpected_field: "the body might be in here somewhere, who knows",
  });
  ok("says there was no body", /no body was found/i.test(out), out);
  ok("lists the fields that did arrive", /unexpected_field/.test(out), out);
  ok("shows array sizes", /attachments: array\(2\)/.test(out), out);
  ok("previews string values", /the body might be in here/.test(out), out);
  ok("is bounded", describePayloadShape({ big: "x".repeat(50000) }).length <= 1800);
  console.log("\n" + out.split("\n").map((l) => "        " + l).join("\n"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
