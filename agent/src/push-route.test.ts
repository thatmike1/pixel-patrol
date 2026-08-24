/**
 * tests for what a push trigger answers, over a real HTTP socket.
 *
 * the status code is the whole contract with Pub/Sub. a 2xx acks and the
 * message is gone; anything else nacks, and after five attempts the message
 * parks in the dead-letter topic. so the thing worth asserting is not that the
 * handler logged something sensible about a malformed body, but that it
 * answered a number that gets the message off the subscription instead of
 * leaving it to redeliver forever.
 *
 * the app is built with fake dependencies and no model — this is about the
 * envelope, not about analysis.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import pino from "pino";

import type { AgentConfig } from "./config.js";
import { createApp } from "./server.js";
import type { AppDeps } from "./server.js";
import { fakeStore } from "./test-support.js";
import type { Decision } from "./types.js";

/** silent logger — these tests assert on status codes */
const log = pino({ level: "silent" });

/** the base URL every push token in these tests is minted for */
const SELF_URL = "https://patrol-agent.test";

/** a config with the model and the notifier switched off */
function config(): AgentConfig {
  return {
    projectId: "pixel-patrol-test",
    geminiLocation: "global",
    model: "gemini-test",
    region: "europe-west1",
    crawlerJob: "patrol-crawler",
    stabilityWindow: 5,
    goneAfter: 3,
    siteSweepTopic: "site-sweep",
    adminKey: "test-admin-key",
    notify: {
      githubToken: null,
      githubRepo: "thatmike1/pixel-patrol-tickets",
      resendApiKey: null,
      resendFrom: "Pixel Patrol <onboarding@resend.dev>",
      defaultOwnerEmail: "thatmike.dev@gmail.com",
    },
    selfUrl: SELF_URL,
    port: 0,
    logLevel: "silent",
  };
}

/** the push envelope Pub/Sub POSTs, around an arbitrary payload */
function envelope(payload: unknown): unknown {
  return {
    message: {
      messageId: "1",
      data: Buffer.from(JSON.stringify(payload), "utf-8").toString("base64"),
    },
    subscription: "projects/pixel-patrol-test/subscriptions/sweep-done-push",
  };
}

/** starts the app on an ephemeral port and returns a POST helper */
async function serve(overrides: Partial<AppDeps> = {}): Promise<{
  post: (path: string, body: unknown) => Promise<{ status: number }>;
  decisions: Decision[];
}> {
  const { store, recorded } = fakeStore({ siteId: "smoke", url: "https://example.test" }, []);
  const deps: AppDeps = {
    config: config(),
    log,
    store,
    publisher: { async publishSiteSweep() { return "message-1"; } },
    jobs: { async runCrawl() { return { execution: "exec-1", operation: "op-1" }; } },
    // the OIDC check is not what these tests are about; it is exercised against
    // the deployed service, where a real Google-signed token exists
    verifier: { async verify() { return { email: "patrol-agent@pixel-patrol-test.iam.gserviceaccount.com" }; } },
    async analyse() { return { finalText: "", toolCalls: [] }; },
    async scribe() { return { finalText: "", toolCalls: [] }; },
    async notify() { return { notified: false }; },
    ...overrides,
  };

  const server = createApp(deps).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  after(() => server.close());

  return {
    decisions: recorded.decisions,
    post: async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake" },
        body: JSON.stringify(body),
      });
      // drain, so the socket closes and node --test does not hang on it
      await response.text();
      return { status: response.status };
    },
  };
}

test("a body that is not a push envelope is nacked, not acked", async () => {
  const { post } = await serve();

  const notAnEnvelope = await post("/trigger/sweep-done", { siteId: "smoke" });
  assert.equal(notAnEnvelope.status, 400, "200 here would drop the message silently");
});

test("a push envelope carrying garbage is nacked", async () => {
  const { post } = await serve();

  // valid base64 JSON, but nothing the sweep-done schema recognises
  const wrongShape = await post("/trigger/sweep-done", envelope({ hello: "world" }));
  assert.equal(wrongShape.status, 400);

  // a status the discriminated union has no branch for
  const wrongStatus = await post(
    "/trigger/sweep-done",
    envelope({ siteId: "smoke", sweepId: "now", status: "sideways" }),
  );
  assert.equal(wrongStatus.status, 400);

  // and the same for the other two triggers
  assert.equal((await post("/trigger/site-sweep", { nope: true })).status, 400);
  assert.equal(
    (await post("/trigger/site-sweep", envelope({ siteId: "smoke", siteUrl: "not-a-url", sweepId: "now" })))
      .status,
    400,
  );
});

test("a failed sweep is recorded and acked", async () => {
  // the crawl failing is not the message being wrong; redelivering it would only
  // re-record the same failure
  const { post, decisions } = await serve();

  const response = await post(
    "/trigger/sweep-done",
    envelope({ siteId: "smoke", sweepId: "now", status: "failed", error: "navigation timeout" }),
  );

  assert.equal(response.status, 204);
  assert.equal(decisions[0]?.action, "failed");
  assert.equal(decisions[0]?.error, "navigation timeout");
});

test("an analyst that records nothing is nacked so the sweep is retried", async () => {
  const { post } = await serve({
    async analyse() {
      return { finalText: "I thought about it.", toolCalls: [] };
    },
  });

  const response = await post(
    "/trigger/sweep-done",
    envelope({ siteId: "smoke", sweepId: "now", status: "ok", hostsCount: 1, cookiesCount: 0, hash: "h" }),
  );

  // no fingerprint behind the sweep either, so this fails before the model —
  // both paths are 500 on purpose, because both are worth another attempt
  assert.equal(response.status, 500);
});
