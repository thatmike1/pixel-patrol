# All Things Agentic: submission checklist

Sources: https://allthingsagentichackathon.devpost.com/rules and https://allthingsagentichackathon.devpost.com/ (fetched 2026-08-21).

## Hard constraints

1. **Deadline:** August 31, 2026, 5:00 P.M. Pacific Time (submission period opened August 3, 2026, 9:00 A.M. PT).
2. **Video cap:** 4 minutes. "If it is longer than 4 minutes, only the first 4 minutes may be evaluated."
3. **Must-use stack:** "Gemini 3.5 or newer accessed through Gemini API or Vertex AI, AND at least one Google Agent Framework: Google ADK, GenAI SDK, Antigravity SDK or GenKit, AND at least one Google Cloud infrastructure service (such as Cloud Run, Cloud SQL, Firestore, GKE, Pub/Sub)."

## Track: The Taskmaster

Verbatim: "Build a complete workflow, not just a chatbot...Build an agent that handles the details, sends the right info to the right places, and proves it can do the heavy lifting for you."

Other tracks (pick exactly one on the form): The Collaborative Partner, The Fortified Enterprise Fleet.

## Deliverables

- [ ] Project category selected on the Devpost form (Taskmaster).
- [ ] Text description covering features, functionality, technologies used, data sources, and findings/learnings.
- [ ] Code repository URL (GitHub, GitLab or Bitbucket). Public or private both allowed.
- [ ] If the repo is private, access granted to **testing@devpost.com** and **cloudhackathons@google.com**.
- [ ] README.md with spin-up instructions (reproducible setup).
- [ ] Architecture diagram: a visual representation of the system.
- [ ] Hosted project URL, described in the rules as "URL to the hosted Project (if available) for judging and testing".
- [ ] Demo video URL (YouTube or Vimeo).

## Video

- [ ] Under 4 minutes.
- [ ] Shows "unedited, live execution of the agent performing its task (via terminal logs, database updates, or UI changes)".
- [ ] Demonstrates the backend running on Google Cloud (Console, Cloud Run dashboard, Vertex AI logs, or a `.run` URL on screen).
- [ ] "uploaded to and made publicly visible on YouTube or Vimeo". Unlisted is not stated as acceptable; publicly visible is the wording, so use public. (unconfirmed whether unlisted counts)
- [ ] In English, or with English subtitles.
- [ ] Covers problem, value proposition, and the live run.

## Stack compliance

- [ ] Gemini 3.5 or newer, via Gemini API or Vertex AI.
- [ ] At least one of: Google ADK, GenAI SDK, Antigravity SDK, GenKit.
- [ ] At least one of: Cloud Run, Cloud SQL, Firestore, GKE, Pub/Sub (the list is "such as", so other GCP infra services should also qualify).

## Judging

- **Innovation & Operational Utility, 40%:** "How much real-world friction does the agent remove on its own? We reward autonomous, high-value action over simple chat, agents that make decisions and complete tasks with little to no hand-holding."
- **Architectural Discipline & Tech Stack, 30%:** "How sound are your engineering choices? We look at how you decouple systems, manage state and memory, secure credentials, and handle failures, robust, production-minded agents, not brittle scripts."
- **Demo & Production Readiness, 30%:** "How clearly do your video and repo prove it works? We want a live, unedited demo, a clean architecture diagram, reproducible setup, and visible proof it runs on Google Cloud."

Final score is 1 to 6 points including bonuses.

## Bonus points (stage three)

- [ ] Publish a piece of content (blog, podcast, video) on a public platform, with hackathon disclosure. Max 0.2 points.
- [ ] Publish a social media post using **#AllThingsAgenticHackathon**. Max 0.2 points.
- [ ] Integrate additional Google AI models (Gemma, Veo, Lyria): 0.2 points each, up to 0.6.

## Fine print

- [ ] **Pre-existing code:** "Projects must be newly created during the Submission Period. Participants may use standard development tools, including frameworks, libraries, starter templates, and AI coding assistants, but must disclose any other pre-existing code or work incorporated into the Project." Reused code from the earlier codebase must be disclosed in the description.
- **Eligibility:** entrants must be above the age of majority. Restricted regions listed: Italy, Quebec, Crimea, Cuba, Iran, Syria, North Korea, Sudan, Belarus, Russia. Czechia is not on the restricted list, so a Czech solo entrant is eligible.
- **Team:** may enter as an individual, a team, or on behalf of an organization, with one authorized Representative. All team members must be listed on the Devpost project. Solo entry is explicitly allowed. (no maximum team size confirmed from these two pages)
- **After the deadline:** "Once the Submission Period has ended, you may not make any changes or alterations to your Submission, but you may continue to update the Project in your Devpost portfolio." The Sponsor may allow removal of infringing or inappropriate content.
- **IP:** entrants keep ownership, but grant Google "a perpetual, irrevocable, worldwide, royalty-free, and non-exclusive license to use, reproduce, adapt, modify, publish, distribute" the submission for judging and for advertising and promotion.
- **Ineligible:** employees, contractors and interns of Google, Devpost, or organizations involved in the contest.
- (unconfirmed) an explicit open-source licence requirement for the repository. Neither page states one.
