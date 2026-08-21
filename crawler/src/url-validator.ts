/**
 * ============================================================================
 *  SSRF / URL VALIDATOR  ——  PARITY-CRITICAL FILE
 * ============================================================================
 *
 *  THIS FILE HAS A SIBLING:
 *      supabase/functions/_shared/url-validator.ts   (Deno runtime)
 *
 *  The two files are INTENTIONALLY DUPLICATED. The scanner runs on Node and
 *  uses `node:dns/promises`; the Supabase edge function runs on Deno and uses
 *  `Deno.resolveDns`. Different runtimes, different DNS APIs, different module
 *  systems — sharing the file across the boundary cost more than it saved.
 *
 *  WHAT MUST STAY IN SYNC:
 *      The IP-literal-detection + IP-classification logic between the markers
 *          // --- PARITY BLOCK START ---
 *          // --- PARITY BLOCK END ---
 *      below. That block is pure (string in → boolean out, no I/O), references
 *      no runtime-specific APIs, and is what `scripts/check-ssrf-parity.sh`
 *      diffs against the sibling.
 *
 *  WHAT IS ALLOWED TO DIFFER:
 *      DNS resolution, URL parsing, error wrapping, logging — anything that
 *      lives OUTSIDE the parity block. Each runtime does these its own way.
 *
 *  WHEN YOU EDIT THIS FILE:
 *      1. If your change is inside the PARITY BLOCK, mirror it byte-for-byte
 *         in the sibling and run `scripts/check-ssrf-parity.sh` before commit.
 *      2. If your change is outside the block, you still must not move the
 *         marker comments and you still must not introduce any I/O inside
 *         the block.
 *      3. This is a SECURITY BOUNDARY. Any divergence is a vulnerability.
 *
 *  WHY NOT JUST SHARE A PACKAGE? See memory: feedback-ssrf-parity.md.
 * ============================================================================
 */

import { promises as dns } from "node:dns";

/** maximum URL length we accept — anything longer is almost certainly hostile or junk */
const MAX_URL_LENGTH = 2048;

/** result of validating a URL — `valid` is the only thing callers should branch on */
export type ValidationResult =
  | { valid: true; resolvedIps: string[] }
  | { valid: false; reason: string };

/**
 * validates a URL is safe to crawl. checks scheme, length, parses, resolves
 * DNS, and rejects any URL whose resolved IPs land in the SSRF denylist.
 *
 * DNS resolution happens AFTER URL parsing so DNS rebinding attacks can't
 * sneak past a syntactic-only check.
 */
export async function validateUrl(rawUrl: string): Promise<ValidationResult> {
  // 1. length check — cheap reject before parsing
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { valid: false, reason: "url is empty" };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { valid: false, reason: `url exceeds ${MAX_URL_LENGTH} chars` };
  }

  // 2. parse — must be a real URL or we bail
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "url is not parseable" };
  }

  // 3. scheme allowlist — http(s) only, nothing weird like file:, gopher:, ftp:
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, reason: `scheme not allowed: ${parsed.protocol}` };
  }

  // 4. extract hostname — strip IPv6 brackets if present
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname.length === 0) {
    return { valid: false, reason: "hostname is empty" };
  }

  // 5. resolve to one or more IPs
  //    - if the hostname IS already an IP literal, skip DNS and classify directly
  //    - otherwise resolve A and AAAA in parallel and classify every result
  let ips: string[];
  if (isIpLiteral(hostname)) {
    ips = [hostname];
  } else {
    try {
      const [v4, v6] = await Promise.all([
        dns.resolve4(hostname).catch(() => [] as string[]),
        dns.resolve6(hostname).catch(() => [] as string[]),
      ]);
      ips = [...v4, ...v6];
    } catch {
      return { valid: false, reason: "dns resolution failed" };
    }
    if (ips.length === 0) {
      return { valid: false, reason: "hostname did not resolve to any ip" };
    }
  }

  // 6. classify each resolved IP — a single bad address taints the whole url
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return { valid: false, reason: `resolved ip is in denylist: ${ip}` };
    }
  }

  return { valid: true, resolvedIps: ips };
}

// --- PARITY BLOCK START ---
// IMPORTANT: this block must stay byte-for-byte identical with the sibling
// validator (see file header). No I/O, no runtime-specific imports, no types
// from outside this block. Only pure string→boolean logic. Run
// scripts/check-ssrf-parity.sh after editing.

/**
 * returns true if the host string is an IP literal (IPv4 dotted quad or
 * IPv6 colon-hex). literals skip DNS and are classified directly, so both
 * runtimes must agree on what counts as a literal — a host that takes the
 * literal path in one runtime and the DNS path in the other is a parity hole.
 */
function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || normalizeIpv6(host) !== null;
}

/**
 * returns true if the given IP literal falls in any SSRF denylist range.
 * accepts IPv4 dotted quads and IPv6 colon-hex strings. unknown formats
 * are treated as unsafe (return true) — fail closed.
 */
function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return isPrivateIpv4(v4);
  }
  const v6 = normalizeIpv6(ip);
  if (v6 !== null) {
    const groups = expandIpv6(v6);
    // malformed ipv6 — fail closed
    if (groups === null) return true;
    return isPrivateIpv6(groups);
  }
  // unparseable — fail closed
  return true;
}

/** parses an IPv4 dotted-quad into 4 octets, or null if not a valid IPv4 */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/** classifies an IPv4 address against the SSRF denylist */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  // 0.0.0.0/8 — "this network", includes the unspecified address
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918 private
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local, includes cloud metadata 169.254.169.254
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * normalizes an IPv6 string to lowercase with no surrounding brackets,
 * or returns null if it doesn't look like IPv6 at all. callers must
 * expand via expandIpv6 before classifying.
 */
function normalizeIpv6(ip: string): string | null {
  const stripped = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (!stripped.includes(":")) return null;
  // basic shape check — hex groups, optional ::, optional embedded v4
  if (!/^[0-9a-f:.]+$/.test(stripped)) return null;
  return stripped;
}

/**
 * expands an IPv6 string (lowercase, bracket-free) into 8 numeric hextets,
 * resolving `::` compression and an embedded dotted-quad tail such as
 * ::ffff:1.2.3.4. returns null if the string is not structurally valid.
 * classification MUST run on the expanded form — the same address has many
 * string spellings (::ffff:127.0.0.1 vs ::ffff:7f00:1 vs 0:0:0:0:0:ffff:...)
 * and prefix-matching the raw string misses denylisted ranges.
 */
function expandIpv6(ip: string): number[] | null {
  let head = ip;
  let tail: string | null = null;
  const dc = ip.indexOf("::");
  if (dc !== -1) {
    if (ip.indexOf("::", dc + 1) !== -1) return null;
    head = ip.slice(0, dc);
    tail = ip.slice(dc + 2);
  }
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === null || tail === "" ? [] : tail.split(":");
  // an embedded dotted quad may only appear as the very last group
  const endParts = tail === null ? headParts : tailParts;
  const last = endParts[endParts.length - 1];
  if (last !== undefined && last.includes(".")) {
    const v4 = parseIpv4(last);
    if (v4 === null) return null;
    endParts.pop();
    endParts.push(((v4[0] << 8) | v4[1]).toString(16));
    endParts.push(((v4[2] << 8) | v4[3]).toString(16));
  }
  const parseHextets = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };
  const headHex = parseHextets(headParts);
  const tailHex = parseHextets(tailParts);
  if (headHex === null || tailHex === null) return null;
  if (tail === null) {
    return headHex.length === 8 ? headHex : null;
  }
  const missing = 8 - headHex.length - tailHex.length;
  if (missing < 1) return null;
  const zeros: number[] = [];
  for (let i = 0; i < missing; i++) zeros.push(0);
  return [...headHex, ...zeros, ...tailHex];
}

/** classifies a fully-expanded IPv6 address (8 hextets) against the SSRF denylist */
function isPrivateIpv6(g: number[]): boolean {
  // ::ffff:0:0/96 — IPv4-mapped: classify the embedded IPv4 instead. matching
  // on expanded hextets catches every spelling (::ffff:a.b.c.d, ::ffff:7f00:1)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    return isPrivateIpv4([
      (g[6]! >> 8) & 0xff,
      g[6]! & 0xff,
      (g[7]! >> 8) & 0xff,
      g[7]! & 0xff,
    ]);
  }
  // :: (unspecified) and ::1 (loopback)
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0 &&
    g[6] === 0 &&
    (g[7] === 0 || g[7] === 1)
  ) {
    return true;
  }
  // fc00::/7 — unique local addresses
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast
  if ((g[0]! & 0xff00) === 0xff00) return true;
  return false;
}

// --- PARITY BLOCK END ---
