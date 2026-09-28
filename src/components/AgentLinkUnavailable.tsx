import { AGENT_LINK_COPY } from "@/lib/booking/booker-copy";
import { cardCls } from "@/components/ui/styles";

/**
 * What an agent's own booking link draws when it books nobody (#2073).
 *
 * ONE sentence for every cause (a token that never existed, one an admin
 * replaced, an advisor who has left or is not taking calls), so the page cannot be
 * used to learn whether a link was ever real or who is still on the roster. Held
 * to a reading width, like the test access refusal beside it.
 *
 * Beneath it, the way on (#2831): a button to the ordinary routed booker, so the
 * lead is never left with nothing to press. It is drawn on EVERY refusal, so its
 * presence discloses nothing. The only prop is where it goes (`agentLinkPoolHref`),
 * which the page decides; nothing about the cause reaches this component.
 */
export function AgentLinkUnavailable({ href }: { href: string }) {
  return (
    <section className={`${cardCls} mx-auto w-full max-w-xl`} data-testid="agent-link-unavailable">
      <h1 className="text-lg font-semibold text-fg">{AGENT_LINK_COPY.unavailable}</h1>
      {/* A plain navigation, so it is a link that looks like the page's one
          action rather than a button that navigates. The big size clears the
          44px target a lead on a phone needs. */}
      <a href={href} className="pn-btn pn-btn--big pn-btn--primary mt-5">
        {AGENT_LINK_COPY.bookAnother}
      </a>
    </section>
  );
}
