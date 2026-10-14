import type { Metadata } from "next";
import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { ClientErrorBeacon } from "@/components/ClientErrorBeacon";
import { AgentLinkUnavailable } from "@/components/AgentLinkUnavailable";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { landingAttendee } from "@/lib/booking/service";
import { landingLookupId } from "@/lib/booking/landing-identity-gate";
import { headers } from "next/headers";
import { agentLinkPoolCode, resolveAgentLink } from "@/lib/agent-link/store";
import { agentLinkPoolHref } from "@/lib/agent-link/link";
import { DEFAULT_BRAND_COLOR } from "@/lib/brand-label";
import { prefillFromQuery } from "@/lib/booking/book-link";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Lead-facing: the brand is Pennie; Slate stays internal. The address names an
// advisor and books them directly, so it is kept out of search results and out
// of the Referer the page sends anywhere else.
export const metadata: Metadata = {
  title: { absolute: "Book a call with Pennie" },
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

type SP = Record<string, string | string[] | undefined>;

function first(sp: SP, key: string): string {
  const v = sp[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * An agent's own booking link (#2073): the page a lead opens from a link their
 * advisor sent for a later call. The booker with the pool resolution removed: no
 * bucket, no round robin, no tier ladder, no fallback. The times are that one
 * advisor's, and the confirm books them or nobody.
 *
 * The address carries the advisor's readable name (#3026), or for a link sent
 * before that, their 64 hex token; `resolveAgentLink` is the one judge of which.
 *
 * A link that books nobody (never real, an advisor who has left or is not taking
 * calls) draws ONE panel whatever the cause, so the page cannot be used to learn
 * which. A link whose read FAILS throws to the booker's error
 * boundary instead, because telling a lead with a good link that their advisor
 * is unavailable is the wrong answer to a database outage.
 *
 * The one call per person notice (#2166) is not asked here, deliberately: a later
 * call with a lead who already has one is what the link exists for.
 */
export default async function AgentLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ link: string }>;
  searchParams: Promise<SP>;
}) {
  const { link: linkKey } = await params;
  const sp = await searchParams;
  const embedded = first(sp, "embed") === "1";
  const theme = first(sp, "theme") === "dark" ? ("dark" as const) : ("light" as const);

  const link = await resolveAgentLink(linkKey);
  if (!link.ok) {
    // The cause, never the name or token: either in the log is a working link in it.
    log.info("agent-link", { msg: "page refused, the link books nobody", why: link.why });
    // #2831: every refusal offers the ordinary routed booker. A link still naming
    // an advisor offers their own pool, anything else the catch all; the button is
    // the same on both, so its presence says nothing about the link. A failed pool
    // read throws to the error boundary rather than quietly offering the catch all.
    const poolCode = await agentLinkPoolCode(linkKey, link.why);
    return (
      <StandaloneBookerShell embedded={embedded} theme={theme}>
        <AgentLinkUnavailable href={agentLinkPoolHref(poolCode, sp)} />
      </StandaloneBookerShell>
    );
  }

  const horizonDays = await loadBookingHorizonDays();
  const reasonOptions = await loadReasonOptions();
  const externalId = first(sp, "external_id") || null;
  const phone =
    first(sp, "phone") || first(sp, "attendeePhoneNumber") || first(sp, "smsReminderNumber");
  const prefill = prefillFromQuery(sp);
  // #2072's vocabulary already names this page: an advisor's direct link. A link
  // that says otherwise keeps its own value, as every other page's does.
  if (!prefill.source) prefill.source = "agent-direct";
  const isTest = link.bucket.is_test;
  // #2208: the same resolver the routed pages use, so an id on the link fills the
  // details Slate already holds and the link's own values always win.
  //
  // #3106: throttled per address like the routed pages, since this link is shared and a
  // lead id is not a secret. Over the ceiling the id still reaches the confirm; only the
  // prefill is left out.
  const lookupId = await landingLookupId(externalId ?? "", headers);
  const attendee = await landingAttendee(
    { salesforceId: lookupId },
    { name: first(sp, "name"), email: first(sp, "email"), phone },
    { isTest },
  );

  return (
    <StandaloneBookerShell embedded={embedded} theme={theme}>
      <ClientErrorBeacon page="/book/advisor" bucketCode="" />
      <Booker
        bucketCode=""
        agentLink={linkKey}
        salesforceId={externalId}
        attendee={attendee}
        prefill={prefill}
        embedded={embedded}
        theme={theme}
        brandColor={first(sp, "brand") || (embedded ? DEFAULT_BRAND_COLOR : undefined)}
        parentOrigin={first(sp, "parentOrigin") || undefined}
        isTest={isTest}
        horizonDays={horizonDays}
        rescheduleReasons={reasonOptions.reschedule.active}
        cancelReasons={reasonOptions.cancel.active}
        landingCall={null}
      />
    </StandaloneBookerShell>
  );
}
