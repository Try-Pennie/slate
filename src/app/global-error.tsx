"use client";

import {
  BOUNDARY_BODY,
  BOUNDARY_RETRY,
  BOUNDARY_TITLE,
  boundaryReference,
  boundaryWayBack,
} from "@/lib/errors/boundary-copy";

/**
 * The last resort, for an error in the root layout itself (#1970).
 *
 * EVERY STYLE HERE IS INLINE, and that is the framework's constraint rather than
 * a choice. `global-error` replaces the root layout and renders its OWN
 * document, so `globals.css` never loads: no design tokens, no Tailwind
 * classes, no PP Mori, and no `data-theme` attribute, since the thing that sets
 * it is the layout that just failed. The Next 16 docs say so in as many words.
 *
 * So the brand values appear here as literals, which is the one place in this
 * repo that is correct rather than a violation of "use CSS variables, never raw
 * hex": a variable that cannot be loaded is not a variable. They are quoted from
 * `globals.css` with their names, so the next person can find the source.
 *
 * colour-ok-file: this file renders its own document and gets no stylesheet, so
 * every value in it is a declaration rather than a use. It is not unguarded:
 * `scripts/test-global-error-tokens.ts` reads both files and fails when a value
 * here is not the one globals.css defines, which is a stronger check than the
 * raw colour scan could make (#1903).
 *
 * The theme follows the OPERATING SYSTEM here rather than the app's own toggle,
 * for the same reason: the app's choice lives in an attribute this document does
 * not have. A `prefers-color-scheme` block is the closest honest approximation,
 * and getting it wrong would mean white on beige.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const reference = boundaryReference(error.digest);
  // Read at render time rather than from a prop, because this document replaces
  // the layout and has no route context to be handed. A lead on the booker gets
  // no link at all: see `boundaryWayBack`.
  const back = boundaryWayBack(
    typeof window === "undefined" ? "" : window.location.pathname,
  );

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        {/* Every value below is QUOTED from globals.css, because this component
            renders its own document and gets no global stylesheet, so it cannot
            reference the tokens. A hand kept copy of another file's values is
            exactly the thing that drifts (L41), and it drifted on the first
            occasion: #1958 moved the dark ladder and these two dark values were
            left behind, still naming the surfaces the theme had before. It
            cannot be derived, so it is GUARDED instead:
            `scripts/test-global-error-tokens.ts` reads both files and fails when
            a value here is not the one globals.css defines. */}
        <style>{`
          .slate-fatal {
            --ground: rgb(249, 246, 240);
            --ink: rgb(52, 52, 52);
            --card: rgb(255, 255, 255);
            --edge: rgba(52, 52, 52, 0.16);
            --action: rgb(130, 208, 255);
          }
          @media (prefers-color-scheme: dark) {
            .slate-fatal {
              --ground: rgb(12, 11, 14);
              --ink: rgb(249, 246, 240);
              --card: rgb(38, 37, 43);
              --edge: rgba(246, 246, 246, 0.38);
              --action: rgb(130, 208, 255);
            }
          }
        `}</style>
        <div
          className="slate-fatal"
          style={{
            background: "var(--ground)",
            color: "var(--ink)",
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            // The brand face cannot load here, so the stack is the platform's
            // own rather than a name that would silently fall back to Times.
            fontFamily:
              "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
            lineHeight: 1.5,
          }}
        >
          <main
            role="alert"
            style={{
              background: "var(--card)",
              border: "1px solid var(--edge)",
              borderRadius: "16px",
              padding: "28px",
              maxWidth: "560px",
              width: "100%",
            }}
          >
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>{BOUNDARY_TITLE}</h1>
            <p style={{ marginTop: "10px", marginBottom: 0, fontSize: "14px", opacity: 0.85 }}>
              {BOUNDARY_BODY}
            </p>
            <div style={{ marginTop: "18px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                onClick={() => retry()}
                style={{
                  background: "var(--action)",
                  // Graphite on sky, which is the pairing the design system
                  // states for a primary action and the one that passes on it.
                  color: "rgb(52, 52, 52)",
                  border: "none",
                  borderRadius: "12px",
                  padding: "11px 18px",
                  font: "inherit",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {BOUNDARY_RETRY}
              </button>
              {/* A plain anchor, not a Link: the router is part of what has
                  failed, so this has to be a real page load. Absent entirely on
                  a lead facing path, where there is nowhere honest to send
                  somebody. */}
              {back && (
                <a
                  href={back.href}
                  style={{
                    border: "1px solid var(--edge)",
                    borderRadius: "12px",
                    padding: "11px 18px",
                    font: "inherit",
                    fontWeight: 600,
                    color: "var(--ink)",
                    textDecoration: "none",
                  }}
                >
                  {back.label}
                </a>
              )}
            </div>
            {reference && (
              <p style={{ marginTop: "14px", marginBottom: 0, fontSize: "12px", opacity: 0.7 }}>
                {reference}
              </p>
            )}
          </main>
        </div>
      </body>
    </html>
  );
}
