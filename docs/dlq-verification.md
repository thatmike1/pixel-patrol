# Retries and dead-lettering, verified

The push subscriptions have carried a dead-letter policy since the plumbing was wired,
and until 24 August 2026 nothing had ever been through it. This is the record of
driving a message down that path on purpose and watching where it came out.

Two things were wrong, and both were only visible from the far end.

## What was wrong

**The dead-letter topics had no subscription attached.** Pub/Sub delivers a published
message to every subscription on a topic and then drops it. A topic with no
subscription is not a queue, it is a sink: the dead-letter policy was configured, the
IAM was right, the expired message was genuinely published to `sweep-done-dlq`, and it
went nowhere. The DLQ existed to make a poison message survive long enough for someone
to read it, and it was doing the opposite silently.

`infra/wire-pubsub.sh` now creates `site-sweep-dlq-pull` and `sweep-done-dlq-pull`,
pull subscriptions with seven days of message retention, before the first dead letter
can arrive.

Everything below was measured after that fix.

## What was tested

### 1. A malformed message is nacked, not acked

```bash
gcloud pubsub topics publish sweep-done --project pixel-patrol-mp \
  --message '{"siteId":"smoke-trackers","sweepId":"dlq-probe-d6","status":"sideways"}' \
  --attribute 'probe=d6-dlq-verification'
```

`status: "sideways"` matches no branch of the `sweep-done` discriminated union. Five
deliveries, five `400`s, over 2.3 seconds:

```
2026-08-24T10:35:15.290572Z  400
2026-08-24T10:35:15.968505Z  400
2026-08-24T10:35:16.493901Z  400
2026-08-24T10:35:17.110507Z  400
2026-08-24T10:35:17.548296Z  400
```

with the reason on each one:

```
"rejected malformed request" — invalid_union, discriminator "status",
                               Expected 'ok' | 'failed'
```

A `400` is the right answer and a `200` would be the bug. The message will never
succeed, so acking it would drop a crawl result on the floor with nothing to show for
it; nacking spends the five attempts the subscription allows and then parks it
somewhere a human can look.

### 2. It lands on the dead-letter subscription

Pulled from `sweep-done-dlq-pull` 27 seconds after publishing:

```bash
gcloud pubsub subscriptions pull sweep-done-dlq-pull --project pixel-patrol-mp --limit 5 \
  --format='table(message.attributes,message.data.decode(base64))'
```

```
ATTRIBUTES                                                  DATA
CloudPubSubDeadLetterSourceDeliveryCount=5                  {"siteId":"smoke-trackers",
CloudPubSubDeadLetterSourceSubscription=sweep-done-push      "sweepId":"dlq-probe-d6",
CloudPubSubDeadLetterSourceSubscriptionProject=pixel-patrol-mp  "status":"sideways"}
CloudPubSubDeadLetterSourceTopicPublishTime=2026-08-24T10:35:14.812+00:00
probe=d6-dlq-verification
```

The payload is intact and the attributes say where it came from and how many times it
was tried. `--max-delivery-attempts 5` was honoured exactly.

The probe was acked afterwards, so a non-empty DLQ stays a real signal.

### 3. A redelivery notifies once

The step that actually escapes the system is the notifier: a GitHub issue and an email.
Everything upstream is keyed by `sweepId` and merely rewrites itself on a replay, but a
second ticket and a second email for one finding is what teaches an owner to stop
reading them.

Sweep `20260824T104620Z-rh5gks` on `demo-shop` recorded drift and notified at
`10:49:08`. Its `sweep-done` message was then republished twice by hand:

```bash
gcloud pubsub topics publish sweep-done --project pixel-patrol-mp \
  --message '{"siteId":"demo-shop","sweepId":"20260824T104620Z-rh5gks","status":"ok",
              "hostsCount":42,"cookiesCount":62,"hash":"replay"}'
```

Both replays ran the analyst, both recorded drift again, and both stopped at the
notifier:

```
10:52:10  already notified; not repeating  issue=1
10:52:10  analysis complete                action=drift
10:52:31  already notified; not repeating  issue=1
10:52:31  analysis complete                action=drift
```

After three deliveries of the same sweep, the repo holds one issue:

```
$ gh issue list --repo thatmike1/pixel-patrol-tickets --state all
#1  demo-shop: +clarity.ms, +doubleclick.net, +facebook.net  (2026-08-24T10:49:08Z)
```

and one email was sent (`7e566d9b-…`, at `10:49:09`), with no second send in the log.

## What is deliberately not dead-lettered

`sweep-tick-push` has no DLQ. The tick carries nothing to poison — the scheduler
publishes a constant `{"tick":true}` — and the next tick is ten minutes away, so a
failed one needs no rescue.

A scribe or notifier failure does not nack. The decision is already written and is the
record everything downstream is built on; a non-2xx there would send the whole delivery
back through Pub/Sub and re-run the expensive analyst to retry the cheap half. Both
failures are logged, and the notifier additionally records the half that did not land
on `sites/{id}/notifications/{sweepId}` so a deliberate replay finishes the job rather
than starting it over.

## Watching it

A parked message that nobody is told about is a slower version of the bug this whole
document is about: the evidence survives, and still nobody finds out.

`infra/wire-alerts.sh` creates the alert that closes it. One Cloud Monitoring policy on
`pubsub.googleapis.com/subscription/num_undelivered_messages`, aligned `ALIGN_MAX` over
five minutes, firing above zero on either `site-sweep-dlq-pull` or `sweep-done-dlq-pull`,
notifying an email channel. The policy body lives in `infra/dlq-alert-policy.json` and
carries the pull command in its documentation field, so the mail says what to do next
rather than only what happened. The script matches the channel by address and the policy
by display name before creating either, so re-running it does not end up sending two
mails per parked message.

Live as `projects/pixel-patrol-mp/alertPolicies/16866233994362950382`, notifying
`thatmike.dev@gmail.com`. It has not fired, because both queues are empty, which is the
correct state and also the reason it has not been observed firing.

## Gaps

The alert proves a message arrived; it does not diagnose it. Reading a dead letter is
still a manual `gcloud pubsub subscriptions pull`, and the message has to be acked by
hand once dealt with, or the alert stays open. That is deliberate at this size: an
automatic drain would quietly restore the original failure, where a poison message
disappears and the system reports success.
