/**
 * `@pixel-patrol/shared` — everything both services must agree on.
 *
 * the crawler writes fingerprints and the agent reads them, so the fingerprint
 * shape, the hash definition, the diff and the stability rules are one
 * definition imported twice rather than two copies kept in step by hand. the
 * hand-synced copy this replaced drifted twice, and a drifted fingerprint type
 * does not fail a build: it makes the differ silently stop seeing hosts.
 *
 * nothing here touches Firestore, Pub/Sub or the network. it is pure, and it is
 * where the tests that must never regress live.
 */

export {
  canonicalJson,
  compareStrings,
  FINGERPRINT_SCHEMA_VERSION,
  fingerprintHash,
} from "./fingerprint.js";
export type {
  CookieCategory,
  Fingerprint,
  FingerprintCookie,
  FingerprintHost,
  FingerprintMeta,
  FingerprintSchemaVersion,
  HashableFingerprint,
  TrackerCategory,
  TrackerType,
} from "./fingerprint.js";

export {
  cookieKey,
  diffFingerprints,
  groupByRegistrableDomain,
  hostKey,
  INCOMPATIBLE_REASON,
  isComparable,
  isIncompatible,
  toCookieDelta,
} from "./diff.js";
export type {
  CookieDelta,
  DiffBasis,
  DiffResult,
  FingerprintDiff,
  HostDelta,
  IncompatibleDiff,
} from "./diff.js";

export {
  alertKeys,
  analyseStability,
  classify,
  DEFAULT_GONE_AFTER,
  DEFAULT_STABILITY_WINDOW,
  hasAlerts,
  isIncompatibleResult,
  isRandomizedCookieName,
  prepareWindow,
  stabilityTable,
  volatileNumericKeys,
} from "./stability.js";
export type {
  CookieEntry,
  DriftAlerts,
  DriftNoise,
  Evidence,
  HostEntry,
  NoiseEntry,
  StabilityClass,
  StabilityFacts,
  StabilityOptions,
  StabilityTable,
  StableDiff,
  StableDiffResult,
} from "./stability.js";
