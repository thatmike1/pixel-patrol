/**
 * filing the ticket.
 *
 * REST rather than Octokit: one POST, and a dependency whose changelog has to
 * be read is a poor trade for it. the fetch implementation is injectable so the
 * tests can assert on the exact request without a network or a nock-style
 * global patch.
 */

/** the issue GitHub created */
export interface FiledIssue {
  number: number;
  url: string;
}

/** what filing an issue needs */
export interface GithubClientConfig {
  /** a token with `issues: write` on the repo */
  token: string;
  /** `owner/repo` */
  repo: string;
  /** injectable for tests; defaults to the global */
  fetchImpl?: typeof fetch;
}

/** thrown when GitHub refused the issue */
export class GithubError extends Error {
  constructor(
    message: string,
    /** the HTTP status, or 0 when the request never got one */
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/**
 * files one issue.
 *
 * @param config the token, the repo and the fetch to use
 * @param input the issue's title and markdown body
 * @returns the created issue's number and URL
 * @throws {GithubError} on any non-201 response
 */
export async function fileIssue(
  config: GithubClientConfig,
  input: { title: string; body: string; labels?: string[] },
): Promise<FiledIssue> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(`https://api.github.com/repos/${config.repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "pixel-patrol",
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
    }),
  });

  if (response.status !== 201) {
    throw new GithubError(
      `github refused the issue: ${response.status} ${await safeText(response)}`,
      response.status,
    );
  }

  const created = (await response.json()) as { number?: number; html_url?: string };
  if (typeof created.number !== "number" || typeof created.html_url !== "string") {
    throw new GithubError("github accepted the issue but returned no number or url", 201);
  }
  return { number: created.number, url: created.html_url };
}

/** an error body is worth having in the log, but never worth failing over */
async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "<unreadable body>";
  }
}
