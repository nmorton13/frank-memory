// Runs the real Worker (src/index.ts) in Node: an in-memory KV for the OAuth library, the vault from
// vault-harness, and DEV_OWNER_EMAIL standing in for Cloudflare Access on the owner routes.
import worker from "../../src/index";
import { createVault } from "./vault-harness";

export const ORIGIN = "http://localhost:8787";
const REDIRECT = "http://localhost:9999/callback";

type Hook = { op: "get" | "put"; prefix: string; reached: () => void; gate: Promise<void> };

/** Workers KV, in memory (no expiry). Hooks can pause one get/put on a key prefix to stage races. */
class MemoryKV {
  data = new Map<string, string>();
  private hooks: Hook[] = [];
  /** Pause the next `op` on a key starting with `prefix`: `reached` resolves when it's waiting, release() lets it run. */
  pauseNext(op: "get" | "put", prefix: string) {
    let release!: () => void, reached!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    this.hooks.push({ op, prefix, reached, gate: new Promise<void>((r) => (release = r)) });
    return { reached: reachedP, release: () => release() };
  }
  private async hook(op: "get" | "put", key: string) {
    const i = this.hooks.findIndex((h) => h.op === op && key.startsWith(h.prefix));
    if (i === -1) return;
    const [h] = this.hooks.splice(i, 1);
    h.reached();
    await h.gate;
  }
  async get(key: string, opts?: unknown) {
    await this.hook("get", key);
    const v = this.data.get(key);
    if (v === undefined) return null;
    const type = typeof opts === "string" ? opts : (opts as { type?: string } | undefined)?.type;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    await this.hook("put", key);
    this.data.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  async delete(key: string) { this.data.delete(key); }
  async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort().map((name) => ({ name }));
    return { keys, list_complete: true, cacheStatus: null };
  }
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createWorker() {
  const h = createVault({ approvalMode: "auto" });
  const kv = new MemoryKV();
  const env = {
    OAUTH_KV: kv, MEMORY_VAULT: { getByName: () => h.vault }, PUBLIC_URL: ORIGIN, DEV_OWNER_EMAIL: "owner@example.com", OWNER_NAME: "Sam",
  } as any;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;
  const call = (path: string, init: RequestInit = {}) => {
    const req = new Request(ORIGIN + path, init);
    req.headers.set("host", new URL(ORIGIN).host); // workerd always sets Host; the MCP handler requires it
    return worker.fetch(req, env, ctx);
  };
  /** Owner request to /api/* (same-origin, as the dashboard sends it). */
  const api = (path: string, method = "GET", body?: unknown) =>
    call("/api" + path, { method, headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

  async function register(name: string) {
    const r = await call("/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
    if (r.status >= 300) throw new Error(`register ${r.status}: ${await r.text()}`);
    return (await r.json()) as { client_id: string };
  }

  /** Authorization request query for a client, with a fresh PKCE pair. */
  async function authQuery(clientId: string) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: "S256", state: "st", resource: `${ORIGIN}/mcp` });
    return { q: q.toString(), verifier };
  }

  /** Open the consent page; returns its handle and the transaction cookie. */
  async function openConsent(q: string) {
    const r = await call(`/authorize?${q}`);
    const page = await r.text();
    if (r.status !== 200) throw new Error(`authorize ${r.status}: ${page.slice(0, 300)}`);
    const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
    const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
    if (!handle) throw new Error("no consent handle");
    return { handle, cookie, page };
  }

  /** Approve on the consent page, POSTing with `postQuery` (normally the same query). Returns the auth code. */
  async function approve(consent: { handle: string; cookie: string }, postQuery: string) {
    const r = await call(`/authorize?${postQuery}`, { method: "POST", headers: { origin: ORIGIN, cookie: consent.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: consent.handle, decision: "approve" }).toString() });
    const loc = r.headers.get("location");
    if (r.status !== 302 || !loc) throw new Error(`approve ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return new URL(loc).searchParams.get("code")!;
  }

  async function token(params: Record<string, string>) {
    const r = await call("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
    return { status: r.status, body: (await r.json()) as any };
  }

  /** Register, approve and exchange: an app connected the normal way. */
  async function connect(name: string) {
    const { client_id } = await register(name);
    const { q, verifier } = await authQuery(client_id);
    const code = await approve(await openConsent(q), q);
    const t = await token({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
    if (t.status !== 200) throw new Error(`token ${t.status}: ${JSON.stringify(t.body)}`);
    return { client_id, access: t.body.access_token as string, refresh: t.body.refresh_token as string, grantId: (t.body.access_token as string).split(":")[1] };
  }

  const refresh = (app: { client_id: string; refresh: string }) =>
    token({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.client_id, resource: `${ORIGIN}/mcp` });

  /** An MCP tools/list call; returns the HTTP status. */
  async function mcp(accessToken: string) {
    const r = await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await r.text();
    return r.status;
  }

  return { h, kv, env, call, api, register, authQuery, openConsent, approve, token, connect, refresh, mcp };
}
