import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { CRAWLER_NAME } from "./robots.ts";

/**
 * Fetching a page an operator pointed us at — with the guard that makes that safe.
 *
 * A crawler is a server-side request the tenant influences, so it is an SSRF
 * surface by construction. Three rules close it:
 *
 * 1. **The address is checked, not the name.** Every hostname is resolved first
 *    and the *resolved* addresses are judged; `localhost` is only one of the ways
 *    to spell `127.0.0.1`, and a name that resolves to a private range is refused
 *    by the address, not by the string.
 * 2. **The socket uses the vetted address.** The connection is given a `lookup`
 *    that answers from the already-checked list, so a DNS answer that changes
 *    between our check and the connect (DNS rebinding) cannot redirect the socket
 *    into the network we just refused.
 * 3. **Redirects stay inside the site.** A redirect to another host is not
 *    followed — a public page must not be able to walk the crawler somewhere else.
 *
 * Ported from the intent of Mastra's `web-fetch` guard (see `docs/attribution.md`);
 * implemented here against `node:http` with no SDK.
 */

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 4;
const USER_AGENT = `${CRAWLER_NAME}/1.0 (+site page routing)`;

export interface ApprovedAddress {
  address: string;
  family: number;
}

export interface FetchOptions {
  /**
   * Local verification crawls `127.0.0.1` on purpose, so the block is a config
   * decision rather than a constant. It defaults to refusing, and the worker says
   * which mode it ran in when a crawl fails.
   */
  allowPrivate: boolean;
  timeoutMs: number;
}

export interface FetchedPage {
  status: number;
  contentType: string;
  body: string;
  /** The URL after in-site redirects — what the page should be filed under. */
  url: string;
}

/** A URL a crawl may touch: http(s), no credentials, no fragment. */
export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http(s) URLs can be crawled, not "${url.protocol}"`);
  if (url.username !== "" || url.password !== "") throw new Error("a crawl URL must not carry credentials");
  url.hash = "";
  return url;
}

export function isBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === undefined || b === undefined) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  // An IPv4-mapped address is the v4 address wearing a v6 coat; block it whole
  // rather than decode every spelling of 127.0.0.1.
  if (lower.startsWith("::ffff:")) return true;
  return false;
}

/**
 * Resolve a host and refuse the whole answer if any address is private: picking
 * the public one out of a mixed answer is how a rebinding attack still lands.
 */
export async function resolveAddresses(hostname: string, allowPrivate: boolean): Promise<ApprovedAddress[]> {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const literal = isIP(bare);
  const addresses: ApprovedAddress[] =
    literal === 0
      ? (await dnsLookup(bare, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family }))
      : [{ address: bare, family: literal }];
  if (addresses.length === 0) throw new Error(`could not resolve ${hostname}`);
  if (!allowPrivate) {
    const blocked = addresses.filter((entry) => isBlockedAddress(entry.address));
    if (blocked.length > 0) {
      throw new Error(
        `${hostname} resolves to a private or reserved address (${blocked.map((entry) => entry.address).join(", ")}) — crawling private networks is refused (SITE_ALLOW_PRIVATE_IPS=1 only for local verification)`,
      );
    }
  }
  return addresses;
}

/**
 * The socket answers from the vetted list, whatever DNS would say now. Node calls
 * `lookup` at connect time; this is the last moment a rebinding could win, so the
 * approved addresses — not the hostname — are what it gets.
 */
function approvedLookup(addresses: ApprovedAddress[]): LookupFunction {
  const lookup = (
    _hostname: string,
    options: { all?: boolean; family?: number } | number,
    callback: (error: NodeJS.ErrnoException | null, address: string | ApprovedAddress[], family?: number) => void,
  ): void => {
    const all = typeof options === "object" && options.all === true;
    const family = typeof options === "number" ? options : (options.family ?? 0);
    const list = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
    const first = list[0];
    if (first === undefined) {
      callback(Object.assign(new Error("no vetted address for this host"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (all) callback(null, list);
    else callback(null, first.address, first.family);
  };
  return lookup as unknown as LookupFunction;
}

interface RawResponse {
  status: number;
  contentType: string;
  location: string | null;
  body: string;
}

function getOnce(url: URL, approved: ApprovedAddress[], timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[/, "").replace(/\]$/, ""),
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.5",
          "accept-encoding": "identity",
        },
        lookup: approvedLookup(approved),
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PAGE_BYTES) {
            response.destroy(new Error(`the page is larger than ${Math.round(MAX_PAGE_BYTES / 1024)} KiB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            location: typeof response.headers.location === "string" ? response.headers.location : null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`the page did not answer within ${timeoutMs} ms`)));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchGuardedPage(rawUrl: string, options: FetchOptions): Promise<FetchedPage> {
  let current = parseHttpUrl(rawUrl);
  const host = current.host;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const approved = await resolveAddresses(current.hostname, options.allowPrivate);
    const response = await getOnce(current, approved, options.timeoutMs);
    if (response.status >= 300 && response.status < 400 && response.location !== null) {
      const next = parseHttpUrl(new URL(response.location, current).toString());
      if (next.host !== host) throw new Error(`${current.host} redirected to ${next.host}; this crawl follows redirects only inside the site`);
      current = next;
      continue;
    }
    return { status: response.status, contentType: response.contentType, body: response.body, url: current.toString() };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects starting at ${rawUrl}`);
}
