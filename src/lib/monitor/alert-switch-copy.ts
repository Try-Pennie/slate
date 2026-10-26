// The alert switches on /admin/alerts, and what each one's current state means.
//
// Dan, 2026-10-26: "I think in general this page is too noisy. We should probably show
// on OR off based on the current state and the wording probably can be less 'wordy'."
// So each switch carries two sentences and the page shows only the one for the box as
// it stands (src/components/admin/AlertSwitch.tsx). Neither says what the box itself
// already says ("nobody is notified" is the unticked box), and neither describes the
// form ("saving applies immediately"). Settled in docs/design/admin-alerts-help-text.html.
//
// Every claim here is one the monitor lane makes true: a second post when it ends is
// promised only for an alert the catalog calls a condition, whose all clear posts then
// (src/lib/notify/alert-catalog.ts); the below tier alert is an incident that posts
// once per booking and never again (CHANGE_ONLY_KEYS), so it promises none.

/** The `monitor_alert_config` column each switch saves, in the order the card draws them. */
export type AlertSwitchName =
  | "low_volume_armed"
  | "failure_rate_armed"
  | "availability_drift_armed"
  | "roster_coverage_armed"
  | "awaiting_activation_armed"
  | "below_lead_tier_armed"
  | "regal_calls_armed";

export interface AlertSwitchCopy {
  name: AlertSwitchName;
  label: string;
  /** What the switch does while ticked. */
  on: string;
  /** What Slate still does while it is not, and any reason to wait before ticking it. */
  off: string;
}

/**
 * The seven switches, in the order the card draws them.
 *
 * `calcomRetired` decides the below tier switch's reason to tick it: before cutover it
 * replaces cal.com's Slack workflow, after it is the only check doing that job. An
 * unreadable answer (null) keeps the before cutover sentence, as the page always has.
 */
export function alertSwitchCopy(calcomRetired: boolean | null): AlertSwitchCopy[] {
  return [
    {
      name: "low_volume_armed",
      label: "Send a Slack alert when bookings drop off",
      on: "Slack gets an alert when bookings fall below the floors above.",
      off: "Slate still counts bookings. Turn this on once the traffic the floors were measured on reaches Slate.",
    },
    {
      name: "failure_rate_armed",
      label: "Send a Slack alert when customers are failing to book",
      on: "Slack gets an alert when too many booking attempts fail, and a follow up once bookings complete again.",
      off: "Slate still checks every 5 minutes and logs what it finds.",
    },
    {
      name: "availability_drift_armed",
      label: "Send a Slack alert when we offer times that are not really free",
      on: "Slack gets an alert naming the bucket when too many offered times are already busy, and a follow up once they are free.",
      off: "Slate still checks the times each bucket offers against the real calendars every 5 minutes, and logs what it finds.",
    },
    {
      name: "roster_coverage_armed",
      label: "Send a Slack alert when nobody works hours we say we are open",
      on: "Slack gets an alert naming the open hours nobody bookable works, and a follow up once every hour is covered.",
      off: "Slate still checks every 5 minutes that someone works each hour we are open, and logs what it finds.",
    },
    {
      name: "awaiting_activation_armed",
      label: "Send a Slack alert when somebody is stuck outside the booking pool",
      on: "Slack gets an alert naming anyone waiting more than four hours, and a follow up once nobody is.",
      off: "Slate still checks every 5 minutes for anyone working who cannot be booked, and logs what it finds.",
    },
    {
      name: "below_lead_tier_armed",
      label: "Send a Slack alert when a lead is booked with a team below their tier",
      on: "Slack gets one alert per call booked below the lead's tier, and never a second about the same call.",
      off:
        "Slate still checks every upcoming call against the lead's tier in Salesforce every 5 minutes, and logs what it finds. " +
        (calcomRetired === true
          ? "cal.com is retired, so this is the only check doing what its Slack workflow did."
          : "Turn this on before cutover, when the cal.com Slack workflow stops."),
    },
    {
      name: "regal_calls_armed",
      label: "Send a Slack alert when somebody not taking bookings is placing calls",
      on: "Slack gets one alert per person a day, plus one when no call from a Slate user arrives all business day, Regal sends a call Slate cannot read, or calls go missing from the show rate.",
      off: "Slate still checks every 5 minutes for calls from anyone not bookable or deactivated, and logs them.",
    },
  ];
}
