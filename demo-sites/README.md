# demo-sites

Five pages the watchdog is pointed at, served by a Cloud Run service with no
dependencies and no logic beyond reading files off disk.

They exist because the alternative was worse. Until now the drift demo ran
against a real Czech e-shop with a planted approval history: the signal was
real, but the sentence describing it was "we deleted three domains out of the
site's fingerprints so the next crawl would find them unaccounted for". The
sentence you want is "a marketer added a tracking pixel and the watchdog opened
a ticket", and the only way to say that honestly is to own the page the pixel
goes on.

## The five shapes

| path | site id | shape | switch |
| --- | --- | --- | --- |
| `/boutique/` | `demo-boutique` | a page with **no third-party host at all** gains a Meta Pixel | `boutique-pixel` |
| `/magazine/` | `demo-magazine` | an approved tracker (Microsoft Clarity) is **removed** | `magazine-clarity` |
| `/clinic/` | `demo-clinic` | gains a host **the vendor tables have never heard of** | `clinic-beacon` |
| `/bistro/` | `demo-bistro` | gains a **cookie**, with the domain set unchanged | `bistro-cookie` |
| `/atelier/` | `demo-atelier` | several real trackers, **never changes** | none |

The businesses are invented. The trackers are not: the pages load the real
`gtag/js`, the real `clarity.ms/tag`, the real `fbevents.js`, so the fingerprints
carry the hosts and cookies those scripts genuinely produce.

`demo-atelier` has no switch, and that is the point of it. A watchdog that
alerts is easy; a watchdog that stays quiet across sweeps of a page loading
Google Analytics, Clarity and a CDN is the harder half of the claim, and it can
only be checked if nobody can flip anything on that page.

`demo-clinic` points at `toplist.cz`, a real and genuinely obscure Czech hit
counter, chosen because the tables do not know it. The expected outcome is
`unclassified`, `vendor: null`, `confidence: low`, and a redline that tells the
owner to establish who runs it before publishing. An invented vendor in a
document filed with a regulator is worse than a gap, so the honest failure is
the feature being demonstrated.

## Nothing here links to anything else here

The crawler discovers pages by following same-origin links, and all five sites
share one Cloud Run hostname. A link from `/boutique/` to `/magazine/` would
make one site's sweep fingerprint the other site's trackers and merge the two
into a single unreadable result. Every nav link on these pages is an in-page
anchor. The index at `/` links to all five and is registered as nothing.

## The switches

Each change lives inline in its page between a marker pair, and is made by
commenting the payload in or out:

```html
<!-- drift:boutique-pixel:start -->
<!--
<script async src="https://connect.facebook.net/en_US/fbevents.js"></script>
-->
<!-- drift:boutique-pixel:end -->
```

```bash
npm --prefix demo-sites run drift -- status
npm --prefix demo-sites run drift -- induce boutique-pixel
npm --prefix demo-sites run drift -- reset
```

`reset` restores every page byte for byte, so `git status` after a demo run says
exactly what that run changed and nothing else. `induce` and `reset` only edit
files — a change is not live until `infra/deploy-demo-sites.sh` has run, and the
two steps are separate so a half-edited page cannot go out mid-demo.

`docs/demo-runbook.md` is the sequence to follow, including which sweeps to
force and where the ticket and the email land.

## Local

```bash
npm --prefix demo-sites run dev     # http://localhost:8080/boutique/
npm --prefix demo-sites test
```

## Deploy

```bash
PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh
```

Deployed `--allow-unauthenticated`, unlike `patrol-agent`: the crawler has to
reach these pages the way a member of the public does, with no credentials. An
authenticated demo target would be proving something easier than the real job.
