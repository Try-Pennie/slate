"use client";

import { useId, useRef, useState } from "react";
import { btnSecondaryCls, inputCls, labelCls } from "@/components/ui/styles";

export const COPY_LINK_COPY = {
  copy: "Copy link",
  copied: "Copied",
  /** The browser refused the clipboard (a permission, an insecure context). The
   *  field is selected for them, so the remedy is one keystroke away. */
  failed: "Could not copy. The link is selected, so copy it from the field.",
} as const;

/**
 * A link somebody is meant to copy and send (#2073, the agent's own booking link),
 * in a read only field beside a copy control.
 *
 * The press SAYS what it did, in a live region, because a clipboard write leaves
 * nothing on screen and a silent success looks exactly like a press that did
 * nothing (L608). A refused write says so too, and selects the link so the
 * ordinary copy keystroke is the whole remedy.
 */
export function CopyLinkField({
  label,
  url,
  labelHidden = false,
}: {
  label: string;
  url: string;
  /** Keep the label for assistive tech only, when a heading right above already
   *  says what the field is and a visible label would state it twice (L605). */
  labelHidden?: boolean;
}) {
  const id = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setOutcome("copied");
    } catch {
      setOutcome("failed");
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(0, url.length);
    }
  }

  return (
    <div>
      <label htmlFor={id} className={labelHidden ? "sr-only" : labelCls}>
        {label}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          ref={fieldRef}
          id={id}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputCls} mt-0 min-w-0 flex-1 font-mono text-xs`}
        />
        <button type="button" className={btnSecondaryCls} onClick={() => void copy()}>
          {COPY_LINK_COPY.copy}
        </button>
      </div>
      <p role="status" className={`mt-1 min-h-[1.25rem] text-xs ${outcome === "failed" ? "text-[var(--error)]" : "text-fg-muted"}`}>
        {outcome === "copied" ? COPY_LINK_COPY.copied : outcome === "failed" ? COPY_LINK_COPY.failed : ""}
      </p>
    </div>
  );
}
