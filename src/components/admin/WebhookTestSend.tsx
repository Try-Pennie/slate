"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Pill } from "@/components/ui/Pill";
import { btnSecondaryCls, inputCls, labelCls } from "@/components/ui/styles";
import type { WebhookTestState } from "@/app/admin/actions";
import { UnsavedGuard } from "@/components/ui/UnsavedGuard";

/**
 * Send one sample event at a URL you paste, and read what came back (#1951).
 *
 * A client component because the RESPONSE is the point: the status and the body
 * the scratch endpoint returned have to appear beside the button that asked for
 * them, and a response body is not something to route through a query string.
 *
 * It renders the REQUEST too, headers and body, because "I'd want to see an
 * example" is half of what Dan asked for and the request that just went out is
 * a better example than any sample kept in a doc: it is what the live path
 * builds, for the format the endpoint is actually configured with.
 */
export function WebhookTestSend({
  action,
}: {
  action: (prev: WebhookTestState, form: FormData) => Promise<WebhookTestState>;
}) {
  const [state, formAction] = useActionState<WebhookTestState, FormData>(action, {
    error: null,
    sent: null,
  });

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-2" autoComplete="off">
        {/* #2076: the address to test against is typed here and nowhere else. */}
        <UnsavedGuard what="the address you typed" formName="webhook-test-send" />
        <label className={labelCls} htmlFor="webhook-test-target">
          Send a test to
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="webhook-test-target"
            name="target"
            type="url"
            required
            placeholder="https://webhook.site/your-unique-url"
            className={`${inputCls} mt-0 max-w-125 flex-1`}
          />
          <SubmitButton className={btnSecondaryCls} pendingLabel="Sending…">
            Send test
          </SubmitButton>
        </div>
      </form>

      {state.error && (
        <p role="alert" className="text-xs text-error">
          {state.error}
        </p>
      )}

      {state.sent && (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* The status carries the verdict, and it is a real one: a receiver
                that answers 500 or redirects has not accepted the delivery, and
                a tick beside either would be a claim nothing measured. */}
            <Pill variant={state.sent.ok ? "status-ok" : "status-error"}>
              {`HTTP ${state.sent.status}`}
            </Pill>
            <span className="text-xs text-fg-muted">
              {state.sent.format} format, sent to {state.sent.target}
            </span>
          </div>

          <div>
            <p className={labelCls}>What the endpoint answered</p>
            <pre className="mt-1 max-h-60 overflow-auto rounded-[var(--radius-md)] bg-[var(--field)] px-3 py-2 text-xs whitespace-pre-wrap break-all text-fg">
              {state.sent.responseBody}
            </pre>
            {state.sent.truncated && (
              <p className="mt-1 text-xs text-fg-muted">
                Cut off here. The endpoint sent more than this panel shows.
              </p>
            )}
          </div>

          <details>
            <summary className="cursor-pointer text-xs font-semibold text-fg marker:text-fg-muted">
              What Slate sent
            </summary>
            <dl className="mt-2 space-y-0.5 text-xs">
              {state.sent.requestHeaders.map(([k, v]) => (
                <div key={k} className="flex flex-wrap gap-x-2">
                  <dt className="font-semibold text-fg-muted">{k}</dt>
                  <dd className="break-all text-fg">{v}</dd>
                </div>
              ))}
            </dl>
            <pre className="mt-2 max-h-80 overflow-auto rounded-[var(--radius-md)] bg-[var(--field)] px-3 py-2 text-xs whitespace-pre-wrap break-all text-fg">
              {prettyJson(state.sent.requestBody)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/**
 * The body, indented if it parses.
 *
 * Falls back to the raw string rather than to an error, because the raw body IS
 * what was sent and showing it unformatted is strictly better than showing
 * nothing (the wire body is compact JSON, so this only ever adds whitespace).
 */
function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
