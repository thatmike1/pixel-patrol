/**
 * tests for the Pub/Sub push envelope decoder.
 *
 * the malformed cases matter as much as the happy path: a body that throws the
 * wrong way turns a poison message into an infinite retry loop instead of a
 * dead-lettered one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePushMessage, PushDecodeError } from "./push-message.js";

/** wraps a payload the way a Pub/Sub push subscription would */
function envelope(payload: unknown, attributes?: Record<string, string>): unknown {
  return {
    subscription: "projects/pixel-patrol-mp/subscriptions/sweep-done-push",
    message: {
      messageId: "12345",
      publishTime: "2026-08-21T18:00:00.000Z",
      data: Buffer.from(JSON.stringify(payload), "utf-8").toString("base64"),
      ...(attributes ? { attributes } : {}),
    },
  };
}

test("decodes base64 JSON data", () => {
  const message = decodePushMessage(
    envelope({ siteId: "smoke", sweepId: "fixture-1", status: "ok" }),
  );

  assert.deepEqual(message.payload, { siteId: "smoke", sweepId: "fixture-1", status: "ok" });
  assert.equal(message.messageId, "12345");
  assert.deepEqual(message.attributes, {});
});

test("carries attributes through", () => {
  const message = decodePushMessage(
    envelope({ tick: true }, { siteId: "smoke", sweepId: "fixture-1" }),
  );

  assert.deepEqual(message.attributes, { siteId: "smoke", sweepId: "fixture-1" });
});

test("a message with no data decodes to a null payload", () => {
  // attributes-only messages are legal; rejecting them would dead-letter a
  // perfectly valid delivery on a technicality
  const message = decodePushMessage({ message: { messageId: "7", attributes: { a: "b" } } });

  assert.equal(message.payload, null);
  assert.deepEqual(message.attributes, { a: "b" });
});

test("non-string attribute values are dropped rather than coerced", () => {
  const message = decodePushMessage({
    message: { messageId: "7", attributes: { good: "yes", bad: 3 } },
  });

  assert.deepEqual(message.attributes, { good: "yes" });
});

test("rejects a body that is not an object", () => {
  assert.throws(() => decodePushMessage("not a body"), PushDecodeError);
  assert.throws(() => decodePushMessage(null), PushDecodeError);
  assert.throws(() => decodePushMessage([1, 2, 3]), PushDecodeError);
});

test("rejects a body with no message", () => {
  assert.throws(() => decodePushMessage({ subscription: "x" }), PushDecodeError);
});

test("rejects data that is not valid JSON", () => {
  const body = {
    message: { messageId: "7", data: Buffer.from("<html>nope", "utf-8").toString("base64") },
  };

  assert.throws(() => decodePushMessage(body), PushDecodeError);
});

test("rejects data that is not a string", () => {
  assert.throws(() => decodePushMessage({ message: { data: 42 } }), PushDecodeError);
});
