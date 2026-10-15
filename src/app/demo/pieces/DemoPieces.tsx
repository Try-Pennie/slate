"use client";

import { useEffect } from "react";

/** The demo booker's link: the test calendar, a made up lead, a Call me now that calls nobody. */
const DEMO_LINK = "demo?callMeNow=above";

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
    const script = document.createElement("script");
    script.src = "/widget.js";
    script.addEventListener("load", draw);
    document.head.appendChild(script);
    return () => script.removeEventListener("load", draw);
  }, [theme]);

  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col gap-4">
      <div id="demo-call-me-now" />
      <div id="demo-times" />
    </div>
  );
}
