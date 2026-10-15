"use client";

import { useEffect } from "react";

/** The demo booker's link: the test calendar, a made up lead, a Call me now that calls nobody. */
const DEMO_LINK = "demo?callMeNow=above";

const WIDGET_SCRIPT_ID = "slate-demo-widget";

type CalFn = ((...args: unknown[]) => void) & { ns: Record<string, (...args: unknown[]) => void> };

/**
 * #3718: what one of Geoff's landing pages does (Geoff, 2026-10-15), on the demo
 * booker: the Call me now piece and the times piece, each placed on its own through
 * the real widget.js, so a press or a picked time opens the real pop up.
 */
export function DemoPieces({ theme }: { theme: "light" | "dark" }) {
  useEffect(() => {
    const w = window as unknown as { Cal?: CalFn };
    const draw = () => {
      const cal = w.Cal;
      if (!cal) return;
      cal("init", "demo", { origin: window.location.origin });
      cal.ns.demo!("ui", { theme });
      cal.ns.demo!("inline", { elementOrSelector: "#demo-call-me-now", calLink: DEMO_LINK, config: { piece: "callMeNow" } });
      cal.ns.demo!("inline", { elementOrSelector: "#demo-times", calLink: DEMO_LINK, config: { piece: "times" } });
    };
    if (w.Cal) {
      draw();
      return;
    }
    // One script however often this draws: a second copy would answer every message
    // from the pieces twice and open two pop ups.
    let script = document.getElementById(WIDGET_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = WIDGET_SCRIPT_ID;
      script.src = "/widget.js";
      document.head.appendChild(script);
    }
    script.addEventListener("load", draw);
    const loading = script;
    return () => loading.removeEventListener("load", draw);
  }, [theme]);

  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col gap-4">
      <div id="demo-call-me-now" />
      <div id="demo-times" />
    </div>
  );
}
