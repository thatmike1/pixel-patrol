/**
 * sending the owner mail, through Resend's REST API.
 *
 * the sender is an address on `ssscribe.app`, a verified Resend sending domain,
 * so mail reaches any recipient. that is worth stating because the shape of the
 * code would be identical on Resend's shared `onboarding@resend.dev` sender,
 * which silently delivers only to the account owner and accepts every other
 * recipient with a 200 and an id before dropping it. a 200 from an unverified
 * sender proves the request was well formed and nothing else; from this one it
 * means the message was accepted for delivery.
 */

/** the id Resend gave the queued message */
export interface SentEmail {
  id: string;
}

/** what sending needs */
export interface ResendClientConfig {
  apiKey: string;
  /** the From header, which must be a sender Resend will accept */
  from: string;
  /** injectable for tests; defaults to the global */
  fetchImpl?: typeof fetch;
}

/** thrown when Resend refused the message */
export class ResendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

/**
 * sends one HTML email.
 *
 * @param config the API key, the sender and the fetch to use
 * @param input the recipient, subject and HTML body
 * @returns the queued message's id
 * @throws {ResendError} on any non-2xx response
 */
export async function sendEmail(
  config: ResendClientConfig,
  input: { to: string; subject: string; html: string },
): Promise<SentEmail> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    }),
  });

  if (!response.ok) {
    throw new ResendError(
      `resend refused the message: ${response.status} ${await safeText(response)}`,
      response.status,
    );
  }

  const sent = (await response.json()) as { id?: string };
  if (typeof sent.id !== "string") {
    throw new ResendError("resend accepted the message but returned no id", response.status);
  }
  return { id: sent.id };
}

/** an error body is worth having in the log, but never worth failing over */
async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "<unreadable body>";
  }
}
