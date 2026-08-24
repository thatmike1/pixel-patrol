# Stability tuning: the verdict on N=5 / M=3

`STABILITY_WINDOW` (N) and `GONE_AFTER` (M) were guesses when they shipped. This
is the check against real data, and the verdict is **leave both alone**.

## What was measured

`smoke-trackers` is `https://www.novinky.cz`, a Czech news site with programmatic
ad slots — the churn benchmark, chosen because its third-party domain set moves
by itself on every pageview. It has been swept hourly since a baseline was
approved at **2026-08-21 20:00 UTC**.

The measurement window is every decision the current stability code produced:
**69 decisions, 2026-08-21 20:23 → 2026-08-24 12:02 UTC.** (Four earlier
decisions predate the window and carry no `noiseCount`; they are excluded, not
counted as noise.)

| | |
| --- | --- |
| decisions | 69 |
| `noop` | 62 |
| `drift` | 7 |
| differences suppressed per sweep | median 10, range 2–14 |
| differences suppressed in total | 643 |
| distinct domains alerted on | 12 |
| domains alerted on **more than once** | **0** |

## The two questions

**Does it under-report?** No. Every one of the 12 domains it alerted on was a
registrable domain absent from the approved baseline and from all five preceding
sweeps. Read the other way: nothing in the suppressed 643 was a first sighting.
The `flapping` bucket is populated by exactly what it was designed for —
`alza.cz` at 20% presence, `im.cz` at 40%, `adform.net`'s `C` and `uid` cookies
at 40%. Those are an ad slot filling with a different bidder, not a site change,
and the current numbers put them where they belong.

**Does it over-report?** Once, and not because N or M is wrong.

The 20:23 sweep on 2026-08-21 reported six domains at once — `2mdn.net`,
`adtrafficquality.google`, `alza.cz`, `googlesyndication.com`,
`googletagservices.com`, `im.cz` — with a `noiseCount` of 2. All six are
programmatic ad tech, and today four of them sit in `pending` at 0% presence and
two classify as `flapping`. With a full window they would have been noise on
sight. They alerted because the baseline had been approved twenty minutes
earlier and there was almost no history to appeal to.

That is a **cold-window** effect, not a threshold error. Raising N would make it
worse, not better: the window would take longer to fill and a fresh site would
alert on its own rotation for longer. Lowering it would let real additions be
explained away by two sweeps of coincidence. The honest description is that a
site's first few sweeps after a baseline produce noisy alerts, and the correct
fix — if it is worth fixing at all — is to suppress non-baseline additions until
the window has reached its size, which is a different rule, not a different
number.

It is left unfixed on purpose. A watchdog that is loud in its first hour and
quiet afterwards fails safe. One tuned to be quiet in its first hour would have
to be quiet by ignoring things, and the failure it exists to prevent is a
marketing pixel that nobody noticed.

### It reproduced itself while this was being written

A fresh baseline was approved on `smoke-trackers` at 12:02 UTC on 2026-08-24 to
clear its pending set. The 13:00 scheduled sweep — the very next one — reported
drift: four domains added (`adsafeprotected.com`, `alza.cz`, `cloudflare.com`,
`google-analytics.com`) and four removed (`2mdn.net`,
`adtrafficquality.google`, `googlesyndication.com`, `googletagservices.com`),
with a `noiseCount` of 3.

Every one of those eight was flapping or pending an hour earlier. Nothing about
novinky.cz changed; the window was emptied along with the baseline, so a
half-full ad rotation read as four arrivals, and the other half of the same
rotation read as four departures. The removal side comes from the same cause:
`absentFromRecent` is vacuously true when there is nothing recent to check
against, so a `gone` needs no three sweeps of evidence when the window is empty.

Two independent instances, two days apart, same mechanism. The operational
consequence is worth stating plainly for whoever runs the demo: **re-baselining
a churn-heavy site costs exactly one noisy drift on the next sweep.** Do it well
before anything is being filmed.

## M=3, separately

`GONE_AFTER` was exercised by the removal demo rather than by novinky.cz, which
has removed nothing since its baseline. A tracker taken off `demo-magazine`
reported `gone` on the next sweep, correctly, because that site's window was
empty at the time (a freshly reset demo site has only its baseline). On a site
with history the same removal costs three sweeps of absence before it is called
a removal, which is the intended trade: a single bad pageview that drops a
script must not read as the site removing a tracker.

Nothing in the 69 measured sweeps of novinky.cz produced a `gone` or a false
`missing-once` that outlived its window (the four `gone` entries at 13:00 on
2026-08-24 fall outside that window and are the cold-window effect above, not
M). `adform.net` and `google-analytics.com` both sat in
`missing-once` during the measurement period and both came back, which is M
doing exactly its job.

## What the numbers are worth

The headline is the ratio: **643 differences seen, 12 reported.** Without the
window, all 69 sweeps would have alerted, most of them several times over, and
the owner would have muted it inside a day. That is the failure mode the window
exists to prevent, and on real ad-tech churn it prevents it without losing a
single first sighting.

`N=5`, `M=3` stay as they are.

## Reproducing this

```bash
PROJECT_ID=pixel-patrol-mp ./infra/stability-report.sh smoke-trackers 5
```

prints the current classification table, the flapping cookies and the recent
decisions. It is read-only. The counts above came from the decision history:

```bash
curl -sS "$AGENT_URL/sites/smoke-trackers/decisions?limit=100" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "x-admin-key: $ADMIN_KEY"
```
