# Devpost submission draft

Paste-ready. Placeholders are marked `[[ ]]` and there are two of them: the video URL,
which lands on day 9, and the team block, which is Devpost profile data rather than text.

- **Track:** The Taskmaster
- **Repository:** https://github.com/thatmike1/pixel-patrol (public)
- **Hosted project URL:** https://demo-sites-b2xhora5ka-ew.a.run.app/
- **Demo video:** `[[VIDEO URL, day 9]]`
- **Team:** `[[solo entrant, Devpost profile]]`
- **Built with:** gemini-3.5-flash, vertex-ai, google-adk, cloud-run, cloud-run-jobs,
  pub-sub, firestore, cloud-scheduler, secret-manager, cloud-build, artifact-registry,
  playwright, typescript, node.js

---

## Inspiration

A cookie policy is a document about software, and it goes stale the moment the software
changes. A marketer adds a Meta Pixel through a tag manager on a Tuesday afternoon and
nobody tells the person whose name is on the privacy policy. The site is now processing
personal data it does not declare, and under the GDPR that is the site owner's problem,
not the marketer's. The gap between "a tracker appeared" and "somebody noticed" is
usually months, and it closes only when a regulator or a customer opens it.

Everyone in this position knows the fix: check periodically, and update the policy when
something changes. Nobody does it, because the checking is tedious and the updating is
worse. A chatbot does not fix that. The work has to happen while nobody is watching, and
it has to show up as a finished document in the place where work already gets tracked.

## What it does

Pixel Patrol watches sites for tracking drift and files the paperwork when it finds
some. Once an hour it crawls every site it is responsible for with a real browser,
records every third-party host and every cookie both before and after the consent banner
is dismissed, and compares that against a baseline someone approved. When something
appeared that nobody decided to add, it identifies the tracker, writes the cookie policy
change in Czech as a redline, writes the Records of Processing Activities row the change
obliges the owner to file, opens a GitHub issue carrying both, and emails the site owner.

There is no human step inside that sequence, and no dashboard anyone has to remember to
open. The first a person hears about a new tracker is a ticket in the tracker they
already use, containing the text they need, ready to paste. A finding leaves the system
exactly once: the outcome is recorded against the sweep id and read before anything is
sent, so an hourly schedule does not re-file the same finding every hour, and a Pub/Sub
redelivery re-runs the analysis and then stops.

The hard half is silence. A raw set difference is not an alert, because on a commercial
site the third-party domain set moves by itself: a programmatic ad slot fills with a
different vendor on every pageview, and CDN hosts rotate their shard names between
crawls. An agent that alerts on that gets muted within a week, and a muted watchdog is
worse than none. So hosts are compared by registrable domain rather than hostname, and
every domain and cookie is classified against the site's own recent history before
anything is reported. Over 69 real decisions on a Czech news site, the system saw 643
differences, reported 12, and reported no domain twice.

## How we built it

**Gemini 3.5 Flash on Vertex AI** is the judgement in the system, reached through the
**Google ADK** as two separate `LlmAgent`s with their own tools and their own job.

The **drift analyst** gets five `FunctionTool`s: read the sweep context, read the
deterministic difference split into alerts and noise, look up what the vendor tables know
about a domain that appeared, approve a first baseline, record a verdict. It decides
whether a difference is a site's first sweep, harmless rotation, or a tracker that
appeared without anyone deciding to add it, and it says so in language the person
answerable for the site can act on.

The **compliance scribe** runs only when the analyst recorded drift. It writes the Czech
cookie-policy redline, naming each vendor's individual cookies and their retention
periods, and the RoPA row.

Everything else is deterministic code the model cannot reach around: reading fingerprints,
computing the set difference, deciding what counts as noise, deduplicating a finding,
filing the ticket, sending the mail. The model may read the alert-versus-noise split but
never redraw it. An LLM asked to eyeball two host lists will occasionally miss one, and a
missed marketing pixel is the one failure this product exists to prevent.

The infrastructure, all on **Google Cloud** in `europe-west1`:

- **Cloud Scheduler** publishes an hourly tick.
- **Pub/Sub** carries every stage. The tick fans out into one message per site, so a site
  whose crawl fails is retried and dead-lettered on its own and cannot stall the fleet.
  Push subscriptions deliver over HTTP with an OIDC token whose audience is the exact
  endpoint being called, so a token minted for one trigger cannot be replayed against
  another. Both work topics have dead-letter topics with pull subscriptions attached and
  a five-attempt policy.
- **Cloud Run Jobs** runs the Playwright crawler. A crawl takes minutes and a push
  request has to be acknowledged in seconds, so the agent starts the execution and lets
  go; the crawler closes the loop by publishing to its own topic when it finishes.
- **Cloud Run** runs the agent service and, separately, the five demo pages.
- **Firestore** in native mode holds all of it: sites, fingerprints, decisions, redlines
  and notifications, keyed by sweep id, which is also the idempotency key throughout.
  Nothing is held in memory between deliveries.
- **Secret Manager** holds the GitHub token and the Resend key, mounted at instance start
  rather than set as environment variables, because `gcloud run services describe` prints
  every environment variable it finds and that is the first command anyone runs when a
  deploy looks wrong.
- **Cloud Build** and **Artifact Registry** build and hold the three images.

TypeScript on Node 22 in npm workspaces, so the fingerprint types and the diff kernel
exist exactly once and both services import the same copy. 135 tests under `node --test`,
no framework.

**Data sources.** The system generates most of its own data: every fingerprint comes from
a real browser visiting a real page, and the history each decision is made against is the
site's own previous sweeps. The one external body of knowledge is a pair of vendor tables
carried in the repo, 500 tracker domains and 1699 cookies, each entry naming the vendor,
the category (analytics, marketing or functional), a Czech description and a typical
retention period. They come from my earlier cookie-scanner project and are disclosed as
pre-existing code below. They are what grounds the analyst: a domain the tables do not
cover, and that the hostname heuristics cannot place either, is reported as `unclassified`
with a null vendor rather than guessed at. The scribe uses the same tables for the
retention periods it quotes in the redline, so the policy text and the classification
cannot disagree with each other.

The demo estate is five pages this project owns and serves, one per class of drift: a
tracker-free page that gains a Meta Pixel, a page whose approved tracker is removed, one
that gains a host the vendor tables have never heard of, one that gains a cookie without
gaining a domain, and one that loads four real trackers and never changes. They load the
real `gtag/js`, the real `clarity.ms/tag` and the real `fbevents.js`, so the fingerprints
are genuine. Because I own the pages, "a marketer added a tracking pixel and the watchdog
opened a ticket" is literally what happened, not a planted history.

## Challenges we ran into

**A confident wrong answer, caught two days before submission.** The page pointed at
`toplist.cz`, a real and obscure Czech hit counter, is there to prove the system will say
"I do not know who this is" rather than guess. The first run came back naming Mailchimp as
the operator, medium confidence, with a basis explaining that the related table entry
`list-manage.com` shares a brand token. The model had followed its instructions exactly.
The evidence it was handed was wrong: the near-match function accepted any four-character
substring in one direction, so `"toplist"` contained `"list"` and Mailchimp was a
neighbour. One loose `includes` in a lookup, and the output was an invented vendor in a
document meant for a regulator. The fix matches words rather than substrings, the exact
case is pinned by a test, and the honest answer is now `vendor: null`, `unclassified`, low
confidence, with a redline telling the owner to establish who runs the domain before
publishing.

**A dead-letter queue that was silently a sink.** The dead-letter policy was configured
and the IAM was correct, and a poison message really was published to the dead-letter
topic, and it went nowhere. Pub/Sub delivers a message to every subscription on a topic
and then drops it, so a dead-letter topic with no subscription attached retains nothing.
The failure mode is invisible: everything reports success and the evidence is gone. Both
dead-letter topics now get a pull subscription with seven-day retention before the first
dead letter can arrive, and the whole path is verified end to end in the repo.

**Tuning the silence honestly.** The stability window's numbers were a guess until they
were checked against real overnight data. Doing that surfaced a real over-report: a site
alerts loudly on its first sweeps after a baseline is approved, because there is no
history to appeal to yet. Raising the window would make it worse. I documented it instead
of tuning it away, because the fix is a new rule, not a new number.

**Least privilege after the fact.** The project accumulated the grants that make things
work quickly. An audit near the end found the static demo page server running as the
default compute account with project-wide editor, an unused Cloud Tasks role, a
project-wide secret accessor made redundant by per-secret bindings, a subscriber role in
a push-only architecture, and `roles/run.developer` granted for a single API call that
needs two permissions. The provisioning script now creates the narrow versions from the
first run, and the whole matrix is written down with the reasoning per grant.

## Accomplishments that we are proud of

The system runs unattended and has been doing so for days, not minutes. Five demo sites
plus two real ones, hourly, filing tickets and sending mail with nobody watching.

**643 differences seen, 12 reported, no domain reported twice.** Staying quiet while a
page loads Google Analytics, Google Tag Manager, Microsoft Clarity and a CDN is the harder
half of the claim, and the half most demos skip.

**The output is finished work, not a notification.** The ticket carries a Czech cookie
policy redline naming each vendor's cookies with their retention periods, plus the RoPA
row. Someone can paste it.

**It says "I do not know" when it does not know**, and there is a test pinning the case
that proves it.

## What we learned

Deciding what an agent is not allowed to do turned out to be more of the design than
deciding what it does. Each capability I moved out of the model and into plain code made
the system more correct and easier to explain. The two agents left are doing things
deterministic code would do worse.

The second lesson is that a demo that arranges its own evidence teaches you nothing. The
early version planted history in a real third party's site so the next crawl would find
something. It worked, and it was worthless, because a botched setup and a sleeping
watchdog look identical from the outside. Owning the watched pages cost a day and made
every subsequent claim checkable.

## What is next

- An alert on the dead-letter subscriptions, so a parked message pages a human instead of
  waiting to be found.
- The cold-window rule: suppress non-baseline additions until a site's history window is
  full, which removes the one honest over-report the tuning data found.
- More than one jurisdiction. The redline is Czech because that is the law I live under,
  but nothing in the pipeline is language-bound except the scribe's prompt and the policy
  templates.
- A pull request against the site's own policy file, for owners who keep it in a repo.
  The ticket tracks the work; the fix belongs in the repo.

## Pre-existing code disclosure

The rules require projects to be newly created during the submission period, with any
pre-existing code disclosed. This is copied from `LIFTED.md` in the repository, which is
kept current.

> Everything under `agent/`, `infra/`, and the orchestration, diffing, baseline, redline,
> ticketing and notification logic is new for this hackathon (21 to 31 August 2026).
>
> **Lifted from gdpr-toolkit (my own unreleased project, 2026).** Copied into
> `crawler/src/` with only import and logger-type changes:
>
> - `crawler.ts` Playwright BFS crawler: pre-consent and post-consent cookie collection,
>   third-party request capture
> - `classifier.ts` tiered cookie and tracker classifier (known DB, regex heuristics)
> - `tracker-db.ts`, `cookie-db.ts` lookups over `known-trackers.json` and
>   `known-cookies.json` (moved to `shared/src/` and `shared/data/` on day 5, so the agent
>   classifies against the same tables the scanner does; the cookie heuristic rules moved
>   with them)
> - `consent-bypass.ts` clicks through common consent banners so post-consent state can be
>   observed
> - `url-validator.ts` SSRF validation for crawl targets (DNS resolution, private range and
>   IPv4-mapped IPv6 checks)
> - `types.ts` shared scan result types
> - `Dockerfile` base (Playwright 1.48 Noble image, non-root user, heap cap)
>
> New in `crawler/`: the Cloud Run Job entry (`job.ts`) and the Firestore and Pub/Sub
> sinks (`sinks.ts`). New in `shared/`: the fingerprint types, hash, stability window and
> diff kernel that both services import (moved out of `crawler/src/fingerprint.ts` on day
> 4), and `knowledge.ts`, the host-grounding lookup and hostname heuristics the agent
> classifies unknown domains with (new on day 5, built on the lifted tables above).
>
> **Third-party.** Standard open-source dependencies as listed in each `package.json`
> (Playwright, pino, Google Cloud client libraries, `@google/adk`, zod, TypeScript).
