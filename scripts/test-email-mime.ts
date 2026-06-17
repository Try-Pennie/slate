// Tests for the pure MIME assembly used by the Gmail sender.
// Run: node --experimental-strip-types scripts/test-email-mime.ts
import { buildMimeMessage, base64Mime } from "../src/lib/notify/email-mime.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

assert(base64Mime("hi") === "aGk=", "base64Mime encodes ascii");

const mime = buildMimeMessage(
  {
    from: "ooo@trypennie.com",
    to: ["a@x.com", "b@y.com"],
    subject: "OOO approvals for June 7th, 2026",
    body: "1 request approved.",
    attachments: [{ filename: "260607 OOO Approvals.csv", content: "h1,h2\nv1,v2", mimeType: "text/csv" }],
  },
  "BND",
);

assert(mime.includes("From: ooo@trypennie.com"), "carries the From header");
assert(mime.includes("To: a@x.com, b@y.com"), "joins multiple recipients");
assert(mime.includes('Content-Type: multipart/mixed; boundary="BND"'), "declares the multipart boundary");
assert(mime.includes("Subject: =?UTF-8?B?"), "subject is RFC 2047 encoded");
assert(mime.includes('filename="260607 OOO Approvals.csv"'), "attachment keeps its filename");
assert(mime.includes(base64Mime("h1,h2\nv1,v2")), "attachment body is base64-encoded");
assert(mime.trimEnd().endsWith("--BND--"), "closes the multipart envelope");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
