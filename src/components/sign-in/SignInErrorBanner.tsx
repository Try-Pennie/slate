import Link from "next/link";

/**
 * Why a sign in did not happen, on either sign in page (#4379): a refusal the callback sent
 * back, or a sign in call that never reached the provider. Rose text and border, never the
 * only signal: it is announced as an alert. A refusal with a way out carries it as a link,
 * never as a second button beside the page's one way in (D1).
 */
export function SignInErrorBanner({
  message,
  link,
}: {
  message: string;
  link?: { label: string; href: string };
}) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error"
    >
      {message}
      {link && (
        <>
          {" "}
          <Link href={link.href} className="font-semibold underline underline-offset-2 hover:no-underline">
            {link.label}
          </Link>
        </>
      )}
    </p>
  );
}
