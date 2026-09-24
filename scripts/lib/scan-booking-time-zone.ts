// Scanner for the booking time zone guard (#1916). Pure, so the guard's
// decisions are unit testable without the tree.
//
// Two rules, each blind where the other looks:
//
//   HARD CODED ZONE.  A rendering file formats a time with `America/New_York`
//     written into it: `timeZone: "America/New_York"`, a Luxon `zone:` option, a
//     `const X = "America/New_York"` that a formatter then reads, or the literal
//     passed straight to a formatter call. Six surfaces did exactly this on the
//     premise that the whole roster was Eastern, which #1739 measured false.
//
//   SERVER FORMATTED.  A booking view model module formats a time into a string
//     at all. The server cannot know the viewer's zone, so any zone it formats in
//     is a guess, and a guess is how Eastern got baked in. These modules carry the
//     ISO instant and the client formats it (`ViewerTime`).
//
// A fallback like `sched?.timezone ?? "America/New_York"` is NOT flagged: that is
// a default for a stored setting, not a display zone, and it is a different
// question. The escape hatch for a deliberate display zone is
// `// zone-ok: <reason>` on the line or in the `//` block directly above it, and
// the reason must say something.

import { readOptOut } from "./opt-out.ts";

export interface ZoneOffender {
  file: string;
  line: number;
  why: string;
}

const EASTERN = String.raw`["'\x60]America\/New_York["'\x60]`;

const HARD_CODED: { re: RegExp; why: string }[] = [
  {
    re: new RegExp(String.raw`\btimeZone\s*:\s*${EASTERN}`),
    why: "formats with timeZone hard coded to America/New_York; render the viewer's zone through ViewerTime",
  },
  {
    re: new RegExp(String.raw`\bzone\s*:\s*${EASTERN}`),
    why: "sets a Luxon zone hard coded to America/New_York; render the viewer's zone through ViewerTime",
  },
  {
    re: new RegExp(String.raw`\b(?:const|let|var)\s+\w+\s*(?::\s*[\w.]+\s*)?=\s*${EASTERN}`),
    why: "declares a zone constant of America/New_York; render the viewer's zone through ViewerTime",
  },
  {
    re: new RegExp(
      String.raw`\b(?:formatSlotDay|formatSlotTime|formatViewerTime|setZone|toLocaleString|toLocaleDateString|toLocaleTimeString)\s*\([^)]*${EASTERN}`,
    ),
    why: "passes America/New_York to a formatter; render the viewer's zone through ViewerTime",
  },
];

const SERVER_FORMAT =
  /\b(?:formatSlotDay|formatSlotTime|formatClockTime|formatLongDate|toLocaleString|toLocaleDateString|toLocaleTimeString|toFormat)\s*\(|\bIntl\.DateTimeFormat\s*\(/;

/** `// zone-ok: <reason>` on the line, or in the comment block directly above it,
 *  read through the shared opt out reader, and only when it carries a reason. */
function optedOut(lines: string[], i: number): boolean {
  return readOptOut(lines, i, "zone-ok:").reasoned;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Rule one: a rendering file that formats in a hard coded Eastern zone. */
export function scanHardCodedZone(file: string, text: string): ZoneOffender[] {
  const lines = text.split("\n");
  const out: ZoneOffender[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    for (const { re, why } of HARD_CODED) {
      if (re.test(line) && !optedOut(lines, i)) {
        out.push({ file, line: i + 1, why });
        break;
      }
    }
  });
  return out;
}

/** Rule two: a booking view model module that formats a time on the server. */
export function scanServerFormatted(file: string, text: string): ZoneOffender[] {
  const lines = text.split("\n");
  const out: ZoneOffender[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (SERVER_FORMAT.test(line) && !optedOut(lines, i)) {
      out.push({
        file,
        line: i + 1,
        why: "formats a time on the server, which cannot know the viewer's zone; carry the ISO instant and render it with ViewerTime",
      });
    }
  });
  return out;
}
