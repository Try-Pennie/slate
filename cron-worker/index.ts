/**
 * Minimal cron Worker for Slate. Cloudflare Cron Triggers invoke `scheduled`,
 * which calls the main app's cron endpoints (guarded by CRON_SECRET). Kept as a
 * separate Worker because the OpenNext-generated app Worker only exports `fetch`.
 *
 *   * * * * *    -> /api/cron/sync      (backstop calendar sync + watch renewal)
 *   *\/5 * * * * -> /api/cron/complete  (mark-complete sweep + webhook retries)
 */
interface Env {
  SLATE_URL: string;
  CRON_SECRET: string;
}

interface ScheduledEvent {
  cron: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

const handler = {
  async scheduled(event: ScheduledEvent, env: Env, ctx: Ctx): Promise<void> {
    let path = "/api/cron/sync";
    if (event.cron.startsWith("*/15")) path = "/api/cron/salesforce";
    else if (event.cron.startsWith("*/5")) path = "/api/cron/complete";
    ctx.waitUntil(
      fetch(`${env.SLATE_URL}${path}`, {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      })
        .then((r) => r.text())
        .catch(() => {}),
    );
  },
};

export default handler;
