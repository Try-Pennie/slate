/**
 * Pure scan behind `scripts/test-alerts-channel-poster.ts` (#3171): find every
 * place a script READS `SLACK_ALERTS_CHANNEL` itself.
 *
 * Why it exists: every bare node alerter ended the same way, reading the channel
 * the workflow names, trimming it, dropping an empty one so the poster refuses it
 * by name, posting, and turning Slack's answer into a reason. Nine copies of that
 * sat in `scripts/` while `postToAlertsChannel` (`scripts/lib/slack-post.ts`)
 * existed to be the one, and each copy was a place the empty value rule could
 * drift. A copy is found by the READ, because the read is the one line no copy can
 * do without: everything after it can be reworded, and the channel still has to
 * come from the environment.
 *
 * What counts, parsed with the TypeScript compiler so the name inside a string or
 * a comment is never a finding (every alerter's own error message names the
 * variable, telling a reader which setting to check):
 *   - `<anything>.SLACK_ALERTS_CHANNEL`, read;
 *   - `<anything>["SLACK_ALERTS_CHANNEL"]`, read.
 *
 * What does not: `delete x.SLACK_ALERTS_CHANNEL` (clearing it is not posting with
 * it), and a property KEY in an object literal (a test building a fake env).
 * Which files are scanned, and the one owner exempt from it, is the caller's call.
 */
import ts from "typescript";

export type AlertsChannelRead = { line: number; text: string };

const NAME = "SLACK_ALERTS_CHANNEL";

export function scanAlertsChannelReads(source: string, fileName = "x.ts"): AlertsChannelRead[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: AlertsChannelRead[] = [];
  const visit = (node: ts.Node) => {
    const named =
      (ts.isPropertyAccessExpression(node) && node.name.text === NAME) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === NAME);
    if (named && !ts.isDeleteExpression(node.parent)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ line: line + 1, text: node.getText(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
