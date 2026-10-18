import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { Request, Response } from "express";
import debug from "debug";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import config from "@/config";

// OAuth for the MCP endpoint, as its own authorization server. Clients identify themselves with Client ID Metadata
// Documents (an HTTPS URL as the client_id, serving the client's metadata), so there's no client registration. The
// user approves a client by entering the app secret. Tokens are signed rather than stored, so there's nothing to keep
// across restarts, and changing the app secret revokes them all.

const DEBUG = debug("services:mcp:auth");

export const issuer = new URL(config.app.publicUrl).href;
export const resource = new URL("/mcp", config.app.publicUrl).href;

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 90 * 24 * 60 * 60;
const REQUEST_TTL = 10 * 60;
const METADATA_MAX_BYTES = 64 * 1024;
const METADATA_TIMEOUT_MS = 5000;
const METADATA_CACHE_MS = { min: 60_000, default: 5 * 60_000, max: 60 * 60_000 };
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

// Tokens: base64url(JSON payload) "." base64url(HMAC). The key is derived from the app secret.
const signingKey = createHmac("sha256", config.app.secret).update("mcp-oauth-tokens").digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

type TokenType = "code" | "access" | "refresh" | "request";
interface Payload {
  typ: TokenType;
  exp: number;
  jti: string;
  [k: string]: unknown;
}

function sign(typ: TokenType, ttl: number, claims: Record<string, unknown>): string {
  const body = b64(JSON.stringify({ ...claims, typ, exp: now() + ttl, jti: randomBytes(12).toString("base64url") }));
  return `${body}.${b64(createHmac("sha256", signingKey).update(body).digest())}`;
}

function verify(token: string, typ: TokenType): Payload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", signingKey).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return payload.typ === typ && payload.exp > now() ? payload : null;
  } catch {
    return null;
  }
}

/** Authorization codes are single-use; remember used ones until they'd have expired anyway. */
const usedCodes = new Map<string, number>();
function consumeCode(jti: string, exp: number) {
  for (const [k, e] of usedCodes) if (e < now()) usedCodes.delete(k);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  return true;
}

function checkResource(requested: URL | undefined) {
  if (requested && requested.href.replace(/\/$/, "") !== resource.replace(/\/$/, ""))
    throw new InvalidTargetError(`This server only issues tokens for ${resource}`);
}

// --- Client ID Metadata Documents ---

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = address.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/** Whether a client_id is a URL this server will fetch metadata from. */
async function checkClientIdUrl(clientId: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (config.app.allowInsecureOAuthClients && (url.protocol === "http:" || url.protocol === "https:")) return url;
  // Per the CIMD draft: HTTPS, with a path, and no fragment, credentials, or dot segments.
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) return null;
  if (clientId.split("?")[0].split("/").some((s) => s === "." || s === "..")) return null;
  // Don't let a client_id make this server request things on its own network.
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return null;
  return url;
}

async function fetchClientMetadata(url: URL): Promise<{ client: OAuthClientInformationFull; maxAge: number } | null> {
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > METADATA_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // The document has to name itself, so one site can't vouch for another's client.
  if (doc?.client_id !== url.href && doc?.client_id !== url.toString()) return null;
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every((u: unknown) => typeof u === "string" && URL.canParse(u)))
    return null;
  // Only public clients: there's nowhere to keep their keys.
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none") return null;
  const maxAge = Number(resp.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1]) * 1000;
  return {
    client: {
      client_id: doc.client_id,
      redirect_uris: doc.redirect_uris,
      client_name: typeof doc.client_name === "string" ? doc.client_name : undefined,
      client_uri: typeof doc.client_uri === "string" ? doc.client_uri : undefined,
      logo_uri: typeof doc.logo_uri === "string" ? doc.logo_uri : undefined,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    maxAge: Number.isFinite(maxAge) ? Math.min(Math.max(maxAge, METADATA_CACHE_MS.min), METADATA_CACHE_MS.max) : METADATA_CACHE_MS.default,
  };
}

const clientCache = new Map<string, { client: OAuthClientInformationFull; until: number }>();

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const cached = clientCache.get(clientId);
    if (cached && cached.until > Date.now()) return cached.client;
    const url = await checkClientIdUrl(clientId);
    if (!url) return undefined;
    try {
      const result = await fetchClientMetadata(url);
      if (!result) return undefined;
      clientCache.set(clientId, { client: result.client, until: Date.now() + result.maxAge });
      return result.client;
    } catch (ex) {
      DEBUG(`Couldn't fetch client metadata from ${clientId}: ${ex}`);
      return undefined;
    }
  },
};

// --- Approval page ---

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function renderApproval(
  res: Response,
  request: string,
  client: { name: string; clientHost: string; redirectHost: string },
  error?: { message: string; status: number },
) {
  const separateRedirect = client.redirectHost !== client.clientHost;
  res
    .status(error?.status ?? 200)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    })
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to ${escapeHtml(new URL(issuer).host)}</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.25rem; } .muted { color: #666; font-size: .875rem; } .error { color: #b00020; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1rem; margin: .5rem 0 1rem; }
  button { padding: .5rem 1rem; font-size: 1rem; margin-right: .5rem; }
</style></head><body>
<h1>Allow ${escapeHtml(client.name)} to use ${escapeHtml(new URL(issuer).host)}?</h1>
<p>It will be able to read and change your notes, library, and tasks.</p>
<p class="muted">Client: ${escapeHtml(client.clientHost)}${separateRedirect ? `<br>Returns to: ${escapeHtml(client.redirectHost)}` : ""}</p>
${error ? `<p class="error">${escapeHtml(error.message)}</p>` : ""}
<form method="post" action="/oauth/approve">
  <input type="hidden" name="request" value="${escapeHtml(request)}">
  <label for="secret">App secret</label>
  <input type="password" id="secret" name="secret" autocomplete="current-password" autofocus>
  <button type="submit" name="decision" value="allow">Allow</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`);
}

function describeClient(client: OAuthClientInformationFull, redirectUri: string) {
  const clientHost = new URL(client.client_id).host;
  return { name: client.client_name ?? clientHost, clientHost, redirectHost: new URL(redirectUri).host };
}

const failures = new Map<string, number[]>();
function tooManyFailures(ip: string) {
  const recent = (failures.get(ip) ?? []).filter((t) => t > Date.now() - FAILURE_WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILURES;
}

const secretDigest = createHash("sha256").update(config.app.secret).digest();

/** Handles the approval form: checks the app secret, then sends the user back to the client with a code. */
export async function approveHandler(req: Request, res: Response) {
  const request = verify(String(req.body?.request ?? ""), "request");
  if (!request) {
    res.status(400).set("Cache-Control", "no-store").send("This sign-in request has expired. Start again from your app.");
    return;
  }
  const { cid, ru, cc, state, scp } = request as unknown as { cid: string; ru: string; cc: string; state?: string; scp: string[] };
  const back = new URL(ru);
  if (state) back.searchParams.set("state", state);

  if (req.body?.decision === "deny") {
    back.searchParams.set("error", "access_denied");
    res.redirect(302, back.href);
    return;
  }

  const client = await clientsStore.getClient(cid);
  if (!client || !client.redirect_uris.includes(ru)) {
    res.status(400).set("Cache-Control", "no-store").send("This app's registration changed. Start again from your app.");
    return;
  }
  const ip = req.ip ?? "unknown";
  if (tooManyFailures(ip)) {
    renderApproval(res, String(req.body.request), describeClient(client, ru), { message: "Too many wrong attempts. Try again later.", status: 429 });
    return;
  }
  const given = createHash("sha256").update(String(req.body?.secret ?? "")).digest();
  if (!timingSafeEqual(given, secretDigest)) {
    failures.get(ip)!.push(Date.now());
    renderApproval(res, String(req.body.request), describeClient(client, ru), { message: "That isn't the app secret.", status: 401 });
    return;
  }

  DEBUG(`Approved ${cid}.`);
  back.searchParams.set("code", sign("code", CODE_TTL, { cid, ru, cc, scp }));
  back.searchParams.set("iss", issuer);
  res.redirect(302, back.href);
}

// --- Provider ---

function issueTokens(clientId: string, scopes: string[]): OAuthTokens {
  return {
    access_token: sign("access", ACCESS_TTL, { cid: clientId, aud: resource, scp: scopes }),
    token_type: "bearer",
    expires_in: ACCESS_TTL,
    refresh_token: sign("refresh", REFRESH_TTL, { cid: clientId, scp: scopes }),
    scope: scopes.join(" ") || undefined,
  };
}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    checkResource(params.resource);
    // Everything the approval form needs, signed so it can't be changed in the browser.
    const request = sign("request", REQUEST_TTL, {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      state: params.state,
      scp: params.scopes ?? [],
    });
    renderApproval(res, request, describeClient(client, params.redirectUri));
  },

  async challengeForAuthorizationCode(client, code) {
    const payload = verify(code, "code");
    if (!payload || payload.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return String(payload.cc);
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
    const payload = verify(code, "code");
    if (!payload || payload.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== payload.ru) throw new InvalidGrantError("redirect_uri doesn't match");
    checkResource(requestedResource);
    if (!consumeCode(payload.jti, payload.exp)) throw new InvalidGrantError("Authorization code has already been used");
    return issueTokens(client.client_id, (payload.scp as string[]) ?? []);
  },

  async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
    const payload = verify(refreshToken, "refresh");
    if (!payload || payload.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    checkResource(requestedResource);
    const granted = (payload.scp as string[]) ?? [];
    return issueTokens(client.client_id, scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const payload = verify(token, "access");
    if (!payload) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: String(payload.cid),
      scopes: (payload.scp as string[]) ?? [],
      expiresAt: payload.exp,
      resource: new URL(String(payload.aud)),
    };
  },
};

export const authorizationServerMetadata = {
  issuer,
  authorization_endpoint: new URL("/authorize", issuer).href,
  token_endpoint: new URL("/token", issuer).href,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
};

export const protectedResourceMetadata = {
  resource,
  authorization_servers: [issuer],
  bearer_methods_supported: ["header"],
  resource_name: new URL(issuer).host,
};
