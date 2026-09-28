import { AGENT_LINK_COPY } from "@/lib/booking/booker-copy";
import { cardCls } from "@/components/ui/styles";

/**
 * What an agent's own booking link draws when it books nobody (#2073).
 *
 * ONE sentence for every cause (a token that never existed, one an admin
 * replaced, an advisor who has left or is not taking calls), so the page cannot be
 * used to learn whether a link was ever real or who is still on the roster. It
 * takes no props for the same reason: there is nothing about the cause it could
 * say. Held to a reading width, like the test access refusal beside it.
 */
export function AgentLinkUnavailable() {
  return (
    <section className={`${cardCls} mx-auto w-full max-w-xl`} data-testid="agent-link-unavailable">
      <h1 className="text-lg font-semibold text-fg">{AGENT_LINK_COPY.unavailable}</h1>
    </section>
  );
}
