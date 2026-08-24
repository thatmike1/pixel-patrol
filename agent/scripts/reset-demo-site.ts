/**
 * wipes a demo site's history so the next sweep is its first one again.
 *
 * this exists because a demo has to be repeatable and the stability window,
 * correctly, does not care about that. once a domain has appeared in a site's
 * recent sweeps, putting the page back and re-inducing the same change gives it
 * a presence ratio strictly between 0 and 1 — `flapping`, rotation, noise. That
 * is the right verdict for a commercial site whose ad slot fills differently on
 * every pageview, and it is the wrong verdict for the second take of a video.
 *
 * so a reset is not "approve a fresh baseline". Approving clears the pending
 * set and re-points the comparison, and leaves the drifted fingerprint sitting
 * in the window where it will explain the next occurrence away as churn. A
 * reset has to delete the sweeps themselves.
 *
 * What it deletes, under `sites/{siteId}`: `fingerprints`, `sweeps`,
 * `decisions`, `redlines`, `notifications`. What it clears on the site document:
 * the approved baseline and both pending sets. What it keeps: the site's id,
 * URL and owner, so the registration and the scheduler are untouched.
 *
 * ## demo sites only
 *
 * Guarded to ids beginning `demo-`, and not overridable by a flag. Decisions and
 * notifications are the record of what was reported to whom and when — on a site
 * anyone is actually responsible for, that record is the product, and a script
 * that can delete it is a liability sitting in the repo next to one that a tired
 * person runs at midnight before a deadline. Demo targets are pages we own and
 * throw away; nothing else is.
 *
 *   npm --prefix agent run reset-demo-site -- demo-boutique
 *   npm --prefix agent run reset-demo-site -- demo-boutique demo-clinic
 *
 * After this, force a sweep: with no history at all the analyst records
 * `baseline-created` and approves it, which is the state every demo starts from.
 */

import { FieldValue, Firestore } from "@google-cloud/firestore";

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID ?? "pixel-patrol-mp";
const siteIds = process.argv.slice(2);

if (siteIds.length === 0) {
  console.error("usage: reset-demo-site <demo-siteId> [demo-siteId ...]");
  process.exit(1);
}

const notDemo = siteIds.filter((id) => !id.startsWith("demo-"));
if (notDemo.length > 0) {
  console.error(
    `refusing to reset ${notDemo.join(", ")}: this deletes a site's decisions and ` +
      `notifications, and those are the record of what was reported. ` +
      `only ids starting "demo-" are throwaway targets.`,
  );
  process.exit(1);
}

/** the subcollections one sweep of a site leaves behind */
const COLLECTIONS = ["fingerprints", "sweeps", "decisions", "redlines", "notifications"] as const;

const db = new Firestore({ projectId });

for (const siteId of siteIds) {
  const siteRef = db.doc(`sites/${siteId}`);
  const site = await siteRef.get();
  if (!site.exists) {
    console.error(`no site at sites/${siteId}`);
    process.exitCode = 1;
    continue;
  }

  const counts: string[] = [];
  for (const name of COLLECTIONS) {
    const snapshot = await siteRef.collection(name).get();
    // one batch per collection; a demo site holds tens of documents, not the
    // 500 a single batch caps at, and chunking for a case that cannot arise
    // would be code nobody ever exercises
    if (snapshot.size > 500) {
      throw new Error(`sites/${siteId}/${name} holds ${snapshot.size} docs; too many for one batch`);
    }
    if (snapshot.empty) continue;
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    counts.push(`${name} ${snapshot.size}`);
  }

  await siteRef.set(
    {
      approvedBaselineId: FieldValue.delete(),
      pendingDomains: FieldValue.delete(),
      pendingCookies: FieldValue.delete(),
      pendingSweepId: FieldValue.delete(),
      lastSweepId: FieldValue.delete(),
      lastSweepAt: FieldValue.delete(),
    },
    { merge: true },
  );

  console.log(`${siteId}: deleted ${counts.join(", ") || "nothing"}; baseline and pending cleared`);
}

console.log("\nnext: force one sweep per site — the analyst will record baseline-created");
