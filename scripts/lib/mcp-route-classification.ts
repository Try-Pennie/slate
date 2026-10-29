// #3536 / #3544: how each of Slate's routes stands with the MCP servers.
//
// Category exemptions are the plan's phase 2.2 list. The `/api/bookings` routes are
// classified ONE BY ONE, which is the plan's reality check 10 applied: the plan had
// them under a single "covered by the booking endpoint (M4)" exemption for M4 to
// convert, but Marcia's five tools reach none of those routes (they reach the same
// service functions through `McpBookingGateway` and its own internal routes, which ARE
// covered, by the booking registry). So the exemption that was to be converted never
// existed here: each route says what it is and why no MCP tool needs it.
//
// Admin and user routes not classified yet sit in the ratchet (`scripts/mcp-route-ratchet.json`)
// for the ops server (#3535, #3537) to cover or exempt; the file can only shrink.
import type { CategoryExemption, RouteExemption } from "./route-manifest.ts";

export const CATEGORY_EXEMPTIONS: CategoryExemption[] = [
  { category: "cron", prefix: "/api/cron", reason: "Scheduled lanes run by the Worker's own cron triggers, never by a person or a model." },
  { category: "smoke", prefix: "/api/smoke", reason: "The production canary's own probes, keyed to the canary alone." },
  { category: "health", prefix: "/api/health", reason: "Uptime and availability probes for external monitors, answering no question a person asks." },
  { category: "csp-report", prefix: "/api/csp-report", reason: "Where browsers post policy violations; an inbound report, not an action." },
  { category: "client-errors", prefix: "/api/client-errors", reason: "The browser error beacon; an inbound report, not an action." },
  { category: "embed config", prefix: "/api/embed/config", reason: "The embed's own settings, read by widget.js on a host page before it builds a booker; it answers no question a person asks." },
  { category: "auth callback", prefix: "/api/auth/callback", reason: "The staff sign in callback, a step of the browser's own login." },
  { category: "slack", prefix: "/api/slack", reason: "Inbound Slack interactions, signed by Slack and answered to Slack." },
  { category: "regal", prefix: "/api/regal", reason: "Inbound Regal call events, sent by Regal on its own key." },
  { category: "google", prefix: "/api/google", reason: "Google Calendar push notifications, authenticated by the channel token." },
  { category: "public pages", prefix: "/booking", reason: "The embed booker's own page and confirm, used by leads in a browser." },
  { category: "public pages", prefix: "/advisor-photo", reason: "Advisor photos served to the booker by content hash." },
  { category: "dev only", prefix: "/dev/preview", reason: "A development preview route that production refuses." },
  {
    category: "lead self service",
    prefix: "/api/bookings/[token]",
    reason: "A lead's own manage links (cancel, reschedule, calendar file, phone), authorised by the lead's manage token in a browser.",
  },
];

export const ROUTE_EXEMPTIONS: RouteExemption[] = [
  {
    path: "/api/bookings",
    reason:
      "The #250 direct booking API, kept permanently for callers that cannot speak MCP (decision 21). Marcia's tools call the same service functions through McpBookingGateway and the covered internal routes, not this route.",
  },
  {
    path: "/api/bookings/cancel",
    reason: "The key authed cancel for Regal journeys and Marcia's existing cancel only key (#2940, #2591); her MCP cancel is the covered internal route.",
  },
  {
    path: "/api/bookings/bookable",
    reason: "The direct booking API's validate only check (#541), keyed like POST /api/bookings; Marcia's find_times offers only times the slot cache holds, so she has no use for it.",
  },
  {
    path: "/api/bookings/cancel-duplicate",
    reason: "Regal's double booking journeys cancelling an earlier duplicate on their own key (#2369), never a lead or a model.",
  },
  {
    path: "/api/program-leads",
    reason: "Bidspoke's lead intake registering an accepted lead as a program lead on its own key (#4388), never a lead or a model.",
  },
  {
    path: "/api/bookings/reassign",
    reason: "The upstream contact stickiness automation forcing a booking onto its owning advisor on its own key (#9), never a lead or a model.",
  },
];
