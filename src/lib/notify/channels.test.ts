import { describe, it, expect } from "vitest";
import { resolveChannels } from "./channels";

// #571: the Slack destination becomes UI-tunable and applies to ALL alerts.
// Precedence store > env > default; the info channel falls back to the resolved
// alerts channel so a quiet signal is never silently lost. This pure resolver
// owns the fallback chain (the cached DB read is a thin wrapper elsewhere). Note
// it reads the RAW env channels separately, NOT the collapsed slackInfoChannel().

describe("resolveChannels", () => {
  it("uses raw env channels when the store is unset", () => {
    const out = resolveChannels(null, { alertsEnv: "#alerts", infoEnv: "#quiet" });
    expect(out).toEqual({ alerts: "#alerts", info: "#quiet" });
  });

  it("prefers the stored channels over env (store wins)", () => {
    const out = resolveChannels(
      { alerts_channel: "#store-alerts", info_channel: "#store-quiet" },
      { alertsEnv: "#alerts", infoEnv: "#quiet" },
    );
    expect(out).toEqual({ alerts: "#store-alerts", info: "#store-quiet" });
  });

  it("treats an empty stored channel as unset and falls through to env", () => {
    const out = resolveChannels(
      { alerts_channel: "", info_channel: "" },
      { alertsEnv: "#alerts", infoEnv: "#quiet" },
    );
    expect(out).toEqual({ alerts: "#alerts", info: "#quiet" });
  });

  it("falls the info channel back to the RESOLVED alerts channel when info is unset everywhere", () => {
    const out = resolveChannels(
      { alerts_channel: "#store-alerts", info_channel: null },
      { alertsEnv: "#env-alerts", infoEnv: "" },
    );
    // info unset in store and env -> uses the resolved alerts channel (store wins there)
    expect(out).toEqual({ alerts: "#store-alerts", info: "#store-alerts" });
  });

  it("is all-empty when nothing is configured anywhere", () => {
    const out = resolveChannels(null, { alertsEnv: "", infoEnv: "" });
    expect(out).toEqual({ alerts: "", info: "" });
  });
});
