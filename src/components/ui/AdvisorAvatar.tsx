"use client";

import { useState, type CSSProperties } from "react";

/**
 * A person's face, or their initials (#3027, folding in #2612).
 *
 * The ONE place a staff photo is drawn, so the fallback cannot be forgotten at a
 * new site (L621): when there is no picture, or the browser cannot draw the one it
 * was given, the initials circle takes its place rather than a broken image icon.
 * Which picture a person gets is decided before this, by `resolveAdvisorPhoto`;
 * this only draws the answer.
 *
 * Decorative in every place it is used: the name is always written beside it, so
 * the image carries no text alternative and is hidden from assistive technology.
 */
export function AdvisorAvatar({
  src,
  initials,
  imgClassName,
  fallbackClassName,
  style,
}: {
  /** From `photoSrc(resolveAdvisorPhoto(...))`; null draws the initials. */
  src: string | null;
  initials: string;
  imgClassName: string;
  fallbackClassName: string;
  style?: CSSProperties;
}) {
  // Keyed on the address, so a new photo gets a fresh chance to load.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  if (src && brokenSrc !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- served from Slate's own origin or Google's; OpenNext on Cloudflare has no image loader
      <img
        src={src}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setBrokenSrc(src)}
        className={imgClassName}
        style={style}
      />
    );
  }
  return (
    <span className={fallbackClassName} style={style} aria-hidden="true">
      {initials}
    </span>
  );
}
