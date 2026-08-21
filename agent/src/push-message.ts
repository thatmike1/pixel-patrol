/**
 * the Pub/Sub push envelope.
 *
 * a push subscription POSTs a wrapper, not the message: the payload sits in
 * `message.data` as base64 of whatever the publisher wrote, which for us is
 * always UTF-8 JSON. pure and dependency-free so it can be tested without a
 * server or an emulator.
 */

/** the decoded contents of one push delivery */
export interface PushMessage {
  /** the JSON the publisher encoded into `message.data` */
  payload: unknown;
  /** publisher-set attributes, empty when none were sent */
  attributes: Record<string, string>;
  /** Pub/Sub's id for the message, stable across redeliveries */
  messageId: string;
  /** how many times Pub/Sub has delivered this message, when the header carried it */
  deliveryAttempt?: number;
}

/** thrown when a request body is not a well-formed push envelope */
export class PushDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushDecodeError";
  }
}

/** narrows an unknown value to a plain object without asserting its fields */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * decodes a Pub/Sub push request body.
 *
 * a message with no `data` decodes to a `null` payload rather than throwing —
 * that is a legal message (attributes only), and rejecting it would send it to
 * the dead-letter queue on a technicality.
 *
 * @param body the parsed JSON request body
 * @returns the decoded payload, attributes and message id
 * @throws {PushDecodeError} when the envelope or its base64 JSON is malformed
 */
export function decodePushMessage(body: unknown): PushMessage {
  if (!isRecord(body)) {
    throw new PushDecodeError("push body is not an object");
  }

  const message = body.message;
  if (!isRecord(message)) {
    throw new PushDecodeError("push body has no `message` object");
  }

  const attributes: Record<string, string> = {};
  if (isRecord(message.attributes)) {
    for (const [key, value] of Object.entries(message.attributes)) {
      if (typeof value === "string") attributes[key] = value;
    }
  }

  const messageId = typeof message.messageId === "string" ? message.messageId : "";

  const rawData = message.data;
  if (rawData === undefined || rawData === null || rawData === "") {
    return { payload: null, attributes, messageId };
  }
  if (typeof rawData !== "string") {
    throw new PushDecodeError("`message.data` is not a base64 string");
  }

  const decoded = Buffer.from(rawData, "base64").toString("utf-8");
  try {
    return { payload: JSON.parse(decoded) as unknown, attributes, messageId };
  } catch {
    throw new PushDecodeError(`\`message.data\` is not valid JSON: ${truncate(decoded)}`);
  }
}

/** keeps a malformed payload out of the logs at full length */
function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}...` : value;
}
