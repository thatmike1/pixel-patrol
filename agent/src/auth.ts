/**
 * request authentication for the two ways into this service.
 *
 * the /trigger/* routes are reached only by Pub/Sub push, which signs each
 * delivery with a Google-issued OIDC token for a service account we configure.
 * Cloud Run is deployed --no-allow-unauthenticated, so the platform already
 * rejects unsigned callers at the edge before a request reaches Node. we verify
 * the token again here anyway: the edge check proves the caller holds
 * run.invoker on this service, not that the caller is our push subscription,
 * and a second identity that gains run.invoker later should not silently
 * inherit the ability to drive sweeps.
 *
 * the /sites routes are for the demo operator and carry a shared header instead
 * — there is no human identity provider in this project.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { OAuth2Client } from "google-auth-library";

/** the identity a verified push token asserts */
export interface PushIdentity {
  email: string;
}

/** thrown when a push token is absent, unverifiable or belongs to someone else */
export class PushAuthError extends Error {
  /** the HTTP status this failure should produce: 401 unauthenticated, 403 wrong identity */
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "PushAuthError";
    this.status = status;
  }
}

/** verifies the OIDC token on a push request against one audience and one caller */
export interface PushVerifier {
  verify(authorizationHeader: string | undefined, audience: string): Promise<PushIdentity>;
}

/**
 * builds a verifier for push deliveries.
 *
 * the client caches Google's signing certificates internally, so one instance is
 * shared across requests rather than built per call.
 *
 * @param expectedEmail the service account the push subscriptions authenticate as
 * @returns a verifier bound to that identity
 */
export function createPushVerifier(expectedEmail: string): PushVerifier {
  const client = new OAuth2Client();

  return {
    async verify(
      authorizationHeader: string | undefined,
      audience: string,
    ): Promise<PushIdentity> {
      const bearer = authorizationHeader?.match(/^Bearer (.+)$/i)?.[1]?.trim();
      if (!bearer) {
        throw new PushAuthError(401, "missing bearer token");
      }

      let email: string | undefined;
      try {
        // audience is the exact push endpoint URL configured on the
        // subscription; a token minted for a different endpoint fails here
        const ticket = await client.verifyIdToken({ idToken: bearer, audience });
        email = ticket.getPayload()?.email;
      } catch (err) {
        throw new PushAuthError(401, `token verification failed: ${errorMessage(err)}`);
      }

      if (email !== expectedEmail) {
        throw new PushAuthError(403, `token belongs to ${email ?? "an unidentified caller"}`);
      }

      return { email };
    },
  };
}

/**
 * constant-time comparison of an operator's admin key against the configured one.
 *
 * @param provided the value of the x-admin-key header, if any
 * @param expected the configured ADMIN_KEY
 * @returns whether the caller may use the operator endpoints
 */
export function isValidAdminKey(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  // timingSafeEqual requires equal lengths and throws otherwise, and returning
  // early on a length mismatch would leak the key's length through timing.
  // hashing first makes both sides a fixed 32 bytes.
  const a = createHash("sha256").update(provided, "utf-8").digest();
  const b = createHash("sha256").update(expected, "utf-8").digest();
  return timingSafeEqual(a, b);
}

/** the message of an unknown thrown value, without assuming it is an Error */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
