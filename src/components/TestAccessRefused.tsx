import { TEST_ACCESS_COPY } from "@/lib/booking/booker-copy";
import { cardCls, proseCls } from "@/components/ui/styles";

/**
 * What `/book` draws instead of the Booker when the public test bucket is not open
 * to the page asking for it (#2666): no Referer, a website nobody approved, or the
 * test path switched off on our side.
 *
 * The reader is a tester, so the heading says what is unavailable and the one
 * sentence under it says why, in words that point at the thing they can act on.
 * The sentence is chosen by the page (`testOriginRefusalSentence`), one per cause,
 * so this component holds no wording of its own beyond the heading.
 */
export function TestAccessRefused({ sentence }: { sentence: string }) {
  return (
    // Held to a reading width, since at a wide window a two line notice stretched
    // across the whole page reads as a banner rather than a message.
    <section className={`${cardCls} mx-auto w-full max-w-xl`} data-testid="test-access-refused">
      <h1 className="text-lg font-semibold text-fg">{TEST_ACCESS_COPY.heading}</h1>
      <p className={`mt-2 text-sm text-fg-muted ${proseCls}`}>{sentence}</p>
    </section>
  );
}
