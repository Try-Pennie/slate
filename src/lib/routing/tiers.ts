import { DEBT_TIER } from "../xbc.ts";

const XBC = /^[1-5][0-3][0-2]$/;

/**
 * The ordered list of bucket codes to try for a tier-drop fallback: the
 * requested code first, then each lower debt tier with the SAME backend + legal
 * digits. "511" => ["511","411","311","211","111"]. Invalid codes return [code].
 */
export function tierLadder(code: string): string[] {
  if (!XBC.test(code)) return [code];
  const adv = Number(code[0]);
  const rest = code.slice(1);
  const out: string[] = [];
  for (let t = adv; t >= 1; t--) out.push(`${t}${rest}`);
  return out;
}

/** The debt_team key for a code's first digit, or null if the code is invalid. */
export function tierKeyOf(code: string): string | null {
  if (!XBC.test(code)) return null;
  return DEBT_TIER[code[0]]?.key ?? null;
}
