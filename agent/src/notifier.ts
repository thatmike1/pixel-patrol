/**
 * the last step: telling a human.
 *
 * everything before this point is a record in Firestore that nobody is looking
 * at. a drift decision and its redline are worth exactly as much as the odds
 * somebody opens the console, which on a watchdog running hourly is zero. so
 * after the scribe writes the paperwork, a ticket is filed and the owner is
 * mailed — both carrying the same content, because the ticket is where the work
 * gets tracked and the mail is where it gets noticed.
 *
 * this is plain code and not a third `LlmAgent`, unlike the analyst and the
 * scribe. those two exist because judgement was needed: what a difference means,
 * and how to write it up for a regulator. nothing here needs judgement. the
 * words already exist in two documents, and what remains — file this, send
 * that, exactly once — is mechanics, where a model can only introduce a way for
 * it to go wrong.
 *
 * ## exactly once
 *
 * Pub/Sub redelivers. a redelivered `sweep-done` re-runs the analyst, which
 * rewrites the same decision document, and the scribe, which rewrites the same
 * redline — both keyed by sweepId, so a replay costs money and changes nothing.
 * neither of those escapes the system. a ticket and an email do, and a second
 * copy of each is the failure that makes an owner stop reading them.
 *
 * so the outcome is recorded at sites/{siteId}/notifications/{sweepId} and read
 * before anything is sent. the two halves are recorded separately: filing the
 * issue can succeed while the mail fails, and the replay then owes the owner
 * only the mail. re-filing the ticket to get the mail out would leave two
 * tickets for one finding, which is the thing being prevented.
 *
 * ## failure
 *
 * a notifier failure is logged, not nacked — the same call the scribe makes,
 * for the same reason. the decision is already written and is what everything
 * downstream is built on; a non-2xx here sends the whole delivery back through
 * Pub/Sub and re-runs the analyst and the scribe as well, paying for both
 * expensive halves to retry the cheap one. what the failure leaves behind is a
 * notification document with the missing half still null and the reason on it,
 * so a deliberate replay finishes the job.
 */

import type { Logger } from "pino";

import type { NotifyConfig } from "./config.js";
import type { Store } from "./firestore.js";
import { fileIssue } from "./notify/github.js";
import { renderEmail, renderIssue } from "./notify/render.js";
import { sendEmail } from "./notify/resend.js";
import type { Decision, EmailDelivery, IssueDelivery, NotificationRecord } from "./types.js";

/** why a drift produced no notification, when it produced none */
export type SkipReason =
  | "not-drift"
  | "already-notified"
  | "no-redline"
  | "no-site"
  | "not-configured";

/** what one notification attempt did */
export interface NotifyOutcome {
  /** true when this attempt filed or sent something */
  notified: boolean;
  /** set when nothing was attempted */
  skipped?: SkipReason;
  /** the record as it now stands, when one was written */
  record?: NotificationRecord;
}

/** what the notifier needs to do its job */
export interface NotifyDeps {
  store: Store;
  log: Logger;
  config: NotifyConfig;
  /** injectable for tests; the clients default to the global fetch */
  fetchImpl?: typeof fetch;
}

/**
 * files the ticket and sends the owner mail for one drift decision.
 *
 * safe to call on every decision: a non-drift verdict, a drift whose scribe
 * failed, and a sweep that has already been notified all return without
 * touching GitHub or Resend.
 *
 * @param deps the store, the logger and the credentials
 * @param decision the verdict the analyst recorded
 * @returns what was done, or why nothing was
 */
export async function notifyDrift(
  deps: NotifyDeps,
  decision: Decision,
): Promise<NotifyOutcome> {
  const { store, log, config } = deps;
  const { siteId, sweepId } = decision;

  if (decision.action !== "drift") return { notified: false, skipped: "not-drift" };

  const existing = await store.getNotification(siteId, sweepId);
  if (existing?.issue && existing.email) {
    log.info({ siteId, sweepId, issue: existing.issue.number }, "already notified; not repeating");
    return { notified: false, skipped: "already-notified", record: existing };
  }

  // the redline is the content. a drift whose scribe failed has nothing to put
  // in a ticket beyond the summary, and a ticket that says "something changed"
  // with no policy edit in it is the notification this product exists to
  // replace. the decision stands, the log says why, and a replay produces both.
  const redline = await store.getRedline(siteId, sweepId);
  if (!redline) {
    log.warn({ siteId, sweepId }, "no redline for this drift; nothing to notify with");
    return { notified: false, skipped: "no-redline" };
  }

  const site = await store.getSite(siteId);
  if (!site) {
    log.error({ siteId, sweepId }, "decision for a site that no longer exists");
    return { notified: false, skipped: "no-site" };
  }

  const wantsIssue = config.githubToken !== null;
  const wantsEmail = config.resendApiKey !== null;
  if (!wantsIssue && !wantsEmail) {
    log.warn({ siteId, sweepId }, "no notification credentials configured; drift not announced");
    return { notified: false, skipped: "not-configured" };
  }

  const content = { site, decision, redline };
  const now = (): string => new Date().toISOString();

  // whatever a previous attempt already landed is kept, never redone
  let issue: IssueDelivery | null = existing?.issue ?? null;
  let issueError: string | undefined;
  if (!issue && config.githubToken) {
    const rendered = renderIssue(content);
    try {
      const filed = await fileIssue(
        { token: config.githubToken, repo: config.githubRepo, fetchImpl: deps.fetchImpl },
        { title: rendered.title, body: rendered.body },
      );
      issue = { ...filed, at: now() };
      log.info({ siteId, sweepId, issue: filed.number, url: filed.url }, "ticket filed");
    } catch (err) {
      issueError = errorMessage(err);
      log.error({ siteId, sweepId, err: issueError }, "filing the ticket failed");
    }
  }

  let email: EmailDelivery | null = existing?.email ?? null;
  let emailError: string | undefined;
  if (!email && config.resendApiKey) {
    // an unset ownerEmail falls back rather than skipping: a site registered
    // before the field existed still has an owner who needs to hear about this
    const to = site.ownerEmail?.trim() || config.defaultOwnerEmail;
    const rendered = renderEmail(content, issue?.url ?? null);
    try {
      const sent = await sendEmail(
        { apiKey: config.resendApiKey, from: config.resendFrom, fetchImpl: deps.fetchImpl },
        { to, subject: rendered.subject, html: rendered.html },
      );
      email = { id: sent.id, to, at: now() };
      log.info({ siteId, sweepId, emailId: sent.id, to }, "owner email sent");
    } catch (err) {
      emailError = errorMessage(err);
      log.error({ siteId, sweepId, to, err: emailError }, "sending the owner email failed");
    }
  }

  const record: NotificationRecord = {
    siteId,
    sweepId,
    issue,
    email,
    ...(issueError ? { issueError } : {}),
    ...(emailError ? { emailError } : {}),
    domains: redline.domains,
    at: now(),
  };
  await store.writeNotification(record);

  return { notified: issue !== null || email !== null, record };
}

/** the message of an unknown thrown value, without assuming it is an Error */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
