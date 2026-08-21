/**
 * the environment contract for the agent service.
 *
 * every value the process needs is read once at boot and validated together, so
 * a misconfigured deployment reports all of its problems in one log line rather
 * than one per crashed request.
 */

/** the fully validated environment for one agent process */
export interface AgentConfig {
  /** GCP project the Firestore, Pub/Sub and Cloud Run clients address */
  projectId: string;
  /** Vertex location for the model — `global`, the only place 3.5 Flash is served */
  geminiLocation: string;
  /** the Gemini model the drift analyst runs on */
  model: string;
  /** region holding the Cloud Run job and this service */
  region: string;
  /** name of the Cloud Run Job that performs a sweep */
  crawlerJob: string;
  /** topic carrying one-site-one-sweep fan-out messages */
  siteSweepTopic: string;
  /** shared secret for the operator endpoints under /sites */
  adminKey: string;
  /**
   * this service's public base URL, used as the expected OIDC audience of
   * Pub/Sub push tokens.
   *
   * optional at boot on purpose: a Cloud Run URL is only known after the first
   * deploy, so the service has to be able to start without it. the /trigger/*
   * routes refuse to serve until it is set (see `requirePushAuth`).
   */
  selfUrl: string | null;
  /** HTTP port — Cloud Run injects this */
  port: number;
  /** pino level */
  logLevel: string;
}

/** default port when PORT is unset (local runs) */
const DEFAULT_PORT = 8080;

/**
 * reads and validates the environment.
 *
 * @param env the environment to read, normally `process.env`
 * @returns the validated configuration
 * @throws if any required variable is missing or malformed
 */
export function readConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const projectId = required("GOOGLE_CLOUD_PROJECT");
  const adminKey = required("ADMIN_KEY");

  let port = DEFAULT_PORT;
  const rawPort = env.PORT?.trim();
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`PORT must be a valid port number, got "${rawPort}"`);
    } else {
      port = parsed;
    }
  }

  // the ADK reads this itself when constructing the Gemini client; we check it
  // here so a service that would silently fall back to the public API key path
  // fails at boot instead of on the first sweep.
  const enterprise = (env.GOOGLE_GENAI_USE_ENTERPRISE ?? env.GOOGLE_GENAI_USE_VERTEXAI ?? "")
    .trim()
    .toLowerCase();
  if (!["true", "1"].includes(enterprise)) {
    problems.push("GOOGLE_GENAI_USE_ENTERPRISE must be true — the model runs on Vertex, not an API key");
  }

  if (problems.length > 0) {
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }

  return {
    projectId,
    geminiLocation: env.GOOGLE_CLOUD_LOCATION?.trim() || "global",
    model: env.MODEL?.trim() || "gemini-3.5-flash",
    region: env.REGION?.trim() || "europe-west1",
    crawlerJob: env.CRAWLER_JOB?.trim() || "patrol-crawler",
    siteSweepTopic: env.SITE_SWEEP_TOPIC?.trim() || "site-sweep",
    adminKey,
    selfUrl: env.SELF_URL?.trim().replace(/\/+$/, "") || null,
    port,
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}
