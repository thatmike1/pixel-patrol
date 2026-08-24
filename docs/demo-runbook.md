# Demo runbook

Copy-paste. Every command below has been run against the live project exactly as
written. Nothing here needs a decision.

The story it tells: **someone edits a page, and the watchdog opens a ticket and
mails the owner without anyone asking it to.** The pages are ours, so that
sentence is literally true — there is no planted history and nothing arranged
except the edit itself.

## Setup, once per shell

```bash
export CLOUDSDK_ACTIVE_CONFIG_NAME=pixel-patrol
export PROJECT_ID=pixel-patrol-mp
export AGENT_URL=https://patrol-agent-b2xhora5ka-ew.a.run.app
export ADMIN_KEY=<the key from the agent-service notes; never in git>

api() {
  local method="$1" path="$2"; shift 2
  curl -sS -X "$method" "${AGENT_URL}${path}" \
    -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
    -H "x-admin-key: ${ADMIN_KEY}" \
    -H 'content-type: application/json' "$@"
}
```

Check it answers before going further:

```bash
api GET /health
```

## The cast

| site id | page | shape it proves |
| --- | --- | --- |
| `demo-boutique` | `/boutique/` | a tracker-free page **gains** a Meta Pixel |
| `demo-magazine` | `/magazine/` | an approved tracker is **removed** |
| `demo-clinic` | `/clinic/` | gains a host **nothing in the tables knows** |
| `demo-bistro` | `/bistro/` | gains a **cookie**, no new domain |
| `demo-atelier` | `/atelier/` | four real trackers, **never alerts** |

Base URL: `https://demo-sites-b2xhora5ka-ew.a.run.app`

Findings land in two places, both live:

- GitHub issues on **https://github.com/thatmike1/pixel-patrol-tickets**
- email from `patrol@ssscribe.app` to `thatmike.dev@gmail.com`

---

## (a) Reset all five baselines

Run this before every take. It takes about four minutes, most of it waiting.

**As of 2026-08-24 the reset is not optional for `demo-boutique`.** A day-8 verification
run drifted that page on purpose to prove the chain still reaches GitHub and email after
the `demo-sites` service moved onto its own service account. It worked (issue #13, since
closed), the page is back at baseline and redeployed, but the drifted sweep is still in
the site's history. Step 2 below is what clears it. Skip step 2 and re-inducing the same
pixel will classify as `flapping` and silently do nothing.

```bash
cd ~/git/pixel-patrol

# 1. pages back to their unedited state
npm --prefix demo-sites run drift -- reset
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh

# 2. wipe each demo site's sweep history
GOOGLE_CLOUD_PROJECT=pixel-patrol-mp npm --prefix agent run reset-demo-site -- \
  demo-boutique demo-magazine demo-clinic demo-bistro demo-atelier

# 3. one sweep each — the analyst records baseline-created and approves it
for s in boutique magazine clinic bistro atelier; do
  api POST "/sites/demo-$s/sweep" -d '{}'; echo
done

# 4. wait, then confirm all five say baseline-created
sleep 150
for s in boutique magazine clinic bistro atelier; do
  printf "%-16s " "demo-$s"
  api GET "/sites/demo-$s/decisions?limit=1" | jq -r '.decisions[0].action'
done
```

**Why the history is wiped and not just re-baselined.** Approving a fresh
baseline clears the pending set but leaves the previous drifted sweep sitting in
the stability window. Re-inducing the same change then gives that domain a
presence ratio strictly between 0 and 1, which classifies as `flapping` —
rotation, noise, no alert. That is the window working correctly, and it is why
take two of a demo silently does nothing if you skip step 2. A botched setup and
a sleeping watchdog look identical from the outside.

`reset-demo-site` refuses any site id not starting `demo-`, because it deletes
decisions and notifications and those are the record of what was reported.

---

## (b) Induce each drift shape

Each one is: flip the switch, redeploy, sweep, read the verdict. **Do the
removal (`demo-magazine`) first if you are doing several** — see the note under
it.

The wait after a forced sweep is about 90 seconds: crawl, then the analyst, the
scribe and the notifier.

### 1. A tracker-free page gains a Meta Pixel — `demo-boutique`

```bash
npm --prefix demo-sites run drift -- induce boutique-pixel
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
api POST /sites/demo-boutique/sweep -d '{}'; echo
sleep 120
api GET "/sites/demo-boutique/decisions?limit=1" | jq '.decisions[0]'
```

Expect `action: "drift"`, `hostsAdded: ["facebook.com", "facebook.net"]`, two
**high**-confidence classifications naming Facebook and Facebook SDK as
marketing, and a Czech redline adding them to the marketing consent section.

The strongest shot for the camera: this page's baseline contains **zero**
third-party hosts, so the before/after is a blank list against two named
marketing domains.

### 2. An approved tracker is removed — `demo-magazine`

```bash
npm --prefix demo-sites run drift -- induce magazine-clarity
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
api POST /sites/demo-magazine/sweep -d '{}'; echo
sleep 120
api GET "/sites/demo-magazine/decisions?limit=1" | jq '.decisions[0]'
```

Expect `action: "drift"` and `hostsRemoved: ["clarity.ms"]`.

**Do this one first.** A removal is called `gone` only after the domain has been
absent from the last `GONE_AFTER` (3) sweeps — one bad pageview must not read as
a removal. Straight after a reset the site has nothing but its baseline, the
window is empty, and the very next sweep reports `gone`. If the site has already
been swept a few times since the reset, the first sweeps after the edit report
`missing-once` and you need four sweeps to reach `gone`:

```bash
for i in 1 2 3 4; do
  api POST /sites/demo-magazine/sweep -d '{}'; echo; sleep 120
done
```

That is the design, not a fault. It is worth saying out loud on camera if it
comes up.

### 3. A host nothing in the tables knows — `demo-clinic`

```bash
npm --prefix demo-sites run drift -- induce clinic-beacon
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
api POST /sites/demo-clinic/sweep -d '{}'; echo
sleep 120
api GET "/sites/demo-clinic/decisions?limit=1" | jq '.decisions[0].classifications'
```

Expect `vendor: null`, `category: "unclassified"`, `confidence: "low"`, and a
basis reading *"the tables and the heuristics have no entry for this domain"*.
The redline says, in Czech, that the owner must establish who runs `toplist.cz`
and for what before publishing.

This is the shape worth dwelling on. The model is holding a real domain it
cannot identify and is refusing to name a company, because an invented vendor in
a document filed with a regulator is worse than a gap. (An earlier version of the
near-match rule *did* invent one here — it matched `toplist` against Mailchimp's
`list-manage.com` on the shared fragment "list". That is fixed, and the test that
pins it is in `shared/src/knowledge.test.ts`.)

### 4. A cookie appears, with no new domain — `demo-bistro`

```bash
npm --prefix demo-sites run drift -- induce bistro-cookie
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
api POST /sites/demo-bistro/sweep -d '{}'; echo
sleep 120
api GET "/sites/demo-bistro/decisions?limit=1" | jq '.decisions[0].summary'
```

Expect `action: "drift"` with `hostsAdded` empty and the summary naming the
`kotelna_vernost` cookie. Nothing new is being contacted; a cookie is being
written, and it is still a consent question.

### 5. The site that must stay quiet — `demo-atelier`

Nothing to induce. It has no switch, on purpose. Sweep it twice and read the
decisions:

```bash
api POST /sites/demo-atelier/sweep -d '{}'; echo; sleep 130
api POST /sites/demo-atelier/sweep -d '{}'; echo; sleep 130
api GET "/sites/demo-atelier/decisions?limit=3" | jq -c '.decisions[] | {action, noiseCount}'
```

Expect `noop` with `noiseCount: 0` every time, over a page loading Google
Analytics, Google Tag Manager, Microsoft Clarity and jsDelivr. Four real
trackers and no alert is the harder half of the claim.

---

## (c) Trigger sweeps

Forced, one site, and the same path a scheduled tick takes:

```bash
api POST /sites/demo-boutique/sweep -d '{}'
```

The hourly schedule fires on its own at `0 * * * *` and sweeps every enabled
site. **Do not change the cadence during a demo** — a drift that has already
been reported is parked in the site's pending set and the next scheduled sweep
correctly answers `noop`, which looks like a miss if you did not expect it.

Watch a sweep go through:

```bash
gcloud run jobs executions list --job patrol-crawler --region europe-west1 \
  --project pixel-patrol-mp --limit 5 \
  --format='table(metadata.name,status.completionTime,status.succeededCount)'
```

The agent's own log lines — good footage, since the rules ask for live execution
visible as terminal logs. Note the `logName`: without it the query returns Cloud
Run's HTTP request log, which carries no `jsonPayload` and looks like the service
is logging nothing.

```bash
gcloud logging read \
  'logName="projects/pixel-patrol-mp/logs/run.googleapis.com%2Fstdout"
   AND resource.labels.service_name="patrol-agent"' \
  --project pixel-patrol-mp --limit 20 \
  --format='value(timestamp,jsonPayload.msg,jsonPayload.siteId,jsonPayload.action)'
```

`tick fanned out` carries `published`, `disabled` and `skipped`; `analysis
complete` carries the action, the summary and the notification outcome.

---

## (d) Where the ticket and the email land

```bash
# what actually left the system, per site
api GET "/sites/demo-boutique/notifications?limit=3" \
  | jq -c '.notifications[] | {sweepId, issue: .issue.number, url: .issue.url, email: .email.id, to: .email.to}'

# the ticket itself
gh issue list --repo thatmike1/pixel-patrol-tickets --limit 5
gh issue view <n> --repo thatmike1/pixel-patrol-tickets
```

The email arrives at **thatmike.dev@gmail.com** from **Pixel Patrol
&lt;patrol@ssscribe.app&gt;**, carrying the same content as the ticket: the
summary, the classification table, the Czech cookie-policy redline and the RoPA
row. `ssscribe.app` is a verified Resend sending domain, so a `200` from the API
means accepted for delivery, not merely accepted.

A finding leaves the system **once**. The outcome is recorded at
`sites/{siteId}/notifications/{sweepId}` and read before anything is sent, so a
Pub/Sub redelivery — or a second forced sweep of the same drift — re-runs the
analysis and stops at `already notified`. If you want a second ticket for the
same shape, reset the site first.

---

## Retiring a site

The scheduler stops sweeping a site the moment it is disabled. The site
document, its decisions, its redlines and its notifications all stay.

```bash
api POST /sites/demo-shop/enabled -d '{"enabled":false}'   # off the schedule
api POST /sites/demo-shop/enabled -d '{"enabled":true}'    # back on
```

`demo-shop` (rohlik.cz) was retired this way on 2026-08-24. It was a third
party's site being crawled hourly for a demo, and there is no longer a reason
for it to be.

A forced sweep still works on a disabled site: the operator asking for one is
the decision the flag exists to automate away.

---

## If something looks wrong

**The sweep found the old page.** The edit is not live until
`deploy-demo-sites.sh` has finished. The tag it builds includes a hash of
`demo-sites/public`, so `gcloud run revisions list --service demo-sites` tells
you which page content is actually serving.

**The drift reported `noop` with a non-zero `noiseCount`.** The change was
classified as rotation or as already-pending. Check where it landed:

```bash
PROJECT_ID=pixel-patrol-mp ./infra/stability-report.sh demo-clinic 5
```

`pending` means it was already reported — reset the site. `flapping` means the
site's history contains the domain, which after a demo run means step 2 of the
reset was skipped.

**Nothing was filed.** `api GET "/sites/<id>/notifications"` carries
`issueError` and `emailError` when a send failed. A notifier failure never fails
the sweep, so the decision and the redline will be there regardless.
