import { createHash, randomBytes } from "crypto";
import { XMLParser } from "fast-xml-parser";
import debug from "debug";
import { sleep } from "@/utils/sleep";

const DEBUG = debug("services:clients:omnifocus:webdav");

const MAX_RETRIES = 3;
const MAX_REDIRECTS = 5;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

function parseChallenge(header: string | null): DigestChallenge | null {
  const match = header?.match(/^\s*Digest\s+(.*)$/is);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const [, k, quoted, bare] of match[1].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
    params[k.toLowerCase()] = quoted ?? bare;
  if (!params.realm || !params.nonce) return null;
  return params as unknown as DigestChallenge;
}

export interface DavEntry {
  name: string;
  isCollection: boolean;
}

/**
 * Minimal WebDAV client for the Omni Sync Server, which uses HTTP Digest auth and redirects each account from
 * sync.omnigroup.com to its own shard.
 */
export class WebDav {
  private challenge: { origin: string; params: DigestChallenge; nc: number } | null = null;
  private xml = new XMLParser({ removeNSPrefix: true, parseTagValue: false, isArray: (name) => name === "response" });

  constructor(
    private username: string,
    private password: string,
  ) {}

  private authorization(method: string, url: URL): string | undefined {
    if (!this.challenge || this.challenge.origin !== url.origin) return undefined;
    const { params } = this.challenge;
    const uri = url.pathname + url.search;
    const ha1 = md5(`${this.username}:${params.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const parts = [
      `username="${this.username}"`,
      `realm="${params.realm}"`,
      `nonce="${params.nonce}"`,
      `uri="${uri}"`,
    ];
    if (params.qop?.split(",").some((q) => q.trim() === "auth")) {
      const nc = (++this.challenge.nc).toString(16).padStart(8, "0");
      const cnonce = randomBytes(8).toString("hex");
      parts.push(
        `response="${md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`,
        `qop=auth`,
        `nc=${nc}`,
        `cnonce="${cnonce}"`,
      );
    } else {
      parts.push(`response="${md5(`${ha1}:${params.nonce}:${ha2}`)}"`);
    }
    if (params.algorithm) parts.push(`algorithm=${params.algorithm}`);
    if (params.opaque) parts.push(`opaque="${params.opaque}"`);
    return `Digest ${parts.join(", ")}`;
  }

  /** Makes a request, following redirects and answering auth challenges. Returns the final response and URL. */
  async request(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: Buffer | string } = {},
  ): Promise<{ resp: Response; url: string }> {
    let target = new URL(url);
    let redirects = 0;
    let freshChallenge = false;
    for (let attempt = 0; ; ) {
      const auth = this.authorization(method, target);
      let resp: Response;
      try {
        resp = await fetch(target, {
          method,
          redirect: "manual",
          headers: { ...init.headers, ...(auth ? { Authorization: auth } : {}) },
          body: init.body,
        });
      } catch (ex) {
        if (++attempt > MAX_RETRIES) throw ex;
        DEBUG(`${method} ${target.pathname} failed (${ex}), retrying.`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
        await resp.arrayBuffer();
        if (++redirects > MAX_REDIRECTS) throw new Error(`Too many redirects for ${url}`);
        target = new URL(resp.headers.get("location")!, target);
        freshChallenge = false; // A new shard will challenge again
        continue;
      }

      if (resp.status === 401) {
        await resp.arrayBuffer();
        // A stale nonce or a new shard needs a fresh challenge; a fresh one that still fails means bad credentials.
        const params = parseChallenge(resp.headers.get("www-authenticate"));
        if (!params || freshChallenge) throw new Error("The Omni Sync Server rejected the username or password.");
        this.challenge = { origin: target.origin, params, nc: 0 };
        freshChallenge = true;
        continue;
      }

      if (resp.status >= 500 && ++attempt <= MAX_RETRIES) {
        await resp.arrayBuffer();
        DEBUG(`${method} ${target.pathname} returned ${resp.status}, retrying.`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return { resp, url: target.toString() };
    }
  }

  private async ok(method: string, url: string, init: Parameters<WebDav["request"]>[2] = {}) {
    const { resp, url: finalUrl } = await this.request(method, url, init);
    if (!resp.ok) throw new Error(`${method} ${new URL(finalUrl).pathname} returned ${resp.status}: ${await resp.text()}`);
    return { resp, url: finalUrl };
  }

  /** Lists a collection's immediate children, and the URL it was found at after redirects. */
  async list(url: string): Promise<{ url: string; entries: DavEntry[] }> {
    const { resp, url: finalUrl } = await this.ok("PROPFIND", url, {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
    });
    const self = decodeURIComponent(new URL(finalUrl).pathname).replace(/\/+$/, "");
    const responses: any[] = this.xml.parse(await resp.text())?.multistatus?.response ?? [];
    const entries = responses
      .map((r) => {
        const href = decodeURIComponent(new URL(String(r.href), finalUrl).pathname).replace(/\/+$/, "");
        const propstat = Array.isArray(r.propstat) ? r.propstat[0] : r.propstat;
        const type = propstat?.prop?.resourcetype;
        return { href, name: href.split("/").pop()!, isCollection: typeof type === "object" && "collection" in type };
      })
      .filter((e) => e.href !== self)
      .map(({ name, isCollection }) => ({ name, isCollection }));
    return { url: finalUrl, entries };
  }

  async get(url: string): Promise<Buffer> {
    const { resp } = await this.ok("GET", url);
    return Buffer.from(await resp.arrayBuffer());
  }

  async put(url: string, body: Buffer) {
    await this.ok("PUT", url, { headers: { "Content-Type": "application/octet-stream" }, body });
  }

  async delete(url: string) {
    const { resp, url: finalUrl } = await this.request("DELETE", url);
    if (!resp.ok && resp.status !== 404)
      throw new Error(`DELETE ${new URL(finalUrl).pathname} returned ${resp.status}: ${await resp.text()}`);
  }
}
