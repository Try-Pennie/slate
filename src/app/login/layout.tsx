import type { ReactNode } from "react";

/**
 * /login renders per request (#2575).
 *
 * The content security policy is enforced here, and Next applies its nonce to the
 * page's scripts only while serving a request. A prerendered /login was built
 * before any request existed, so its scripts would carry no nonce and the policy
 * would refuse every one of them: a sign in page that never runs. The page is a
 * client component, which cannot carry route segment config, so the segment's
 * layout does, and passes the page through untouched.
 */
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
