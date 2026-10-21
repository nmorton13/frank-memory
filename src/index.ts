import OAuthProvider, { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { resolveCaller, signInConfigured } from "./auth";
import { fillOwner, intParam } from "./helpers";
import { connectInstructions } from "./connect";
import { defaultGuide } from "./guide";
import { buildMcpServer } from "./mcp";
import { handleAuthorize, listConnectedApps, OAUTH_USER_ID } from "./oauth";
import { renderUi } from "./ui";
import type { MemoryVault } from "./vault";

export { MemoryVault } from "./vault";

const VAULT_NAME = "personal";
function vaultStub(env: Env): DurableObjectStub<MemoryVault> {
  const ns = env.MEMORY_VAULT as any;
  return typeof ns.getByName === "function" ? ns.getByName(VAULT_NAME) : env.MEMORY_VAULT.get(env.MEMORY_VAULT.idFromName(VAULT_NAME));
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** HTML responses: no framing (clickjacking), no referrer leaks, no caching. */
function html(body: string, status = 200, extra?: HeadersInit) {
  const h = new Headers(extra);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set("content-security-policy", "frame-ancestors 'none'");
  h.set("referrer-policy", "no-referrer");
  return new Response(body, { status, headers: h });
}
const SIGN_IN_PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>frank-memory</title><body style="font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem"><h2>frank-memory</h2><p>This vault signs in through Cloudflare Access, and this request didn't carry a valid Access identity. Open the vault at its Access-protected address and sign in there.</p>`;

async function api(req: Request, url: URL, vault: DurableObjectStub<MemoryVault>, env: Env): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, "");
  const m = req.method;
  const body = async () => (m === "GET" ? {} : ((await req.json().catch(() => ({}))) as any));
  const qp = url.searchParams;
  let r: RegExpMatchArray | null;

  if (p === "/guide/default" && m === "GET") return json({ content: defaultGuide(env.OWNER_NAME) });
  if (p === "/guide" && m === "GET") return json({ ...(await vault.getOperatingGuide()), history: await vault.guideHistory(), newer_default: await vault.newerDefaultGuide() });
  if (p === "/guide" && m === "PUT") return json(await vault.updateOperatingGuide(String((await body()).content ?? ""), "ui"));
  if (p === "/settings" && m === "GET") return json(await vault.getSettings());
  if (p === "/settings" && m === "PUT") {
    const b = await body();
    if (b.approval_mode !== undefined) {
      const r = await vault.setApprovalMode(String(b.approval_mode), "ui");
      if (!r.ok) return json(r);
    }
    if (b.retention !== undefined) {
      const r = await vault.setRetention(b.retention && typeof b.retention === "object" ? b.retention : {}, "ui");
      if (!r.ok) return json(r);
    }
    return json({ ok: true, ...(await vault.getSettings()) });
  }
  if (p === "/cleanup" && m === "POST") return json(await vault.cleanup("ui"));
  if (p === "/reindex" && m === "POST") return json(await vault.rebuildIndex({ reembed: qp.get("reembed") === "1" }, "ui"));
  if (p === "/memories" && m === "GET")
    return json(await vault.listMemories(
      { type: qp.get("type") || undefined, status: qp.get("status") || undefined, batch_id: qp.get("batch_id") || undefined, q: qp.get("q") || undefined, area: qp.get("area") || undefined },
      intParam(qp.get("limit"), 100, 1, 500), intParam(qp.get("offset"), 0, 0, 1_000_000)));
  if (p === "/memories" && m === "POST") return json(await vault.remember({ ...(await body()), actor: "ui" }));
  if (p === "/recall" && m === "GET")
    return json(await vault.recall({ query: qp.get("q") ?? "", limit: intParam(qp.get("limit"), 20, 1, 50), type: qp.get("type") || undefined,
      status: qp.get("status") || undefined, area: qp.get("area") || undefined, complete: qp.get("complete") === "1" }));
  if ((r = p.match(/^\/memories\/([\w-]+)$/))) {
    if (m === "PATCH") return json(await vault.updateMemory(r[1], await body(), "ui"));
    if (m === "DELETE") return json(await vault.deleteMemory(r[1], "ui"));
  }
  if ((r = p.match(/^\/memories\/([\w-]+)\/(approve|reject|forget)$/)) && m === "POST") {
    if (r[2] === "approve") return json(await vault.approve(r[1], "ui", { supersedeSimilar: qp.get("supersede_similar") === "1" }));
    if (r[2] === "reject") return json(await vault.reject(r[1], "ui"));
    return json(await vault.forget({ id: r[1], actor: "ui" }));
  }
  if ((r = p.match(/^\/memories\/([\w-]+)\/area$/)) && m === "POST") {
    const area = (await body()).area;
    return json(await vault.setMemoryArea(r[1], typeof area === "string" ? area : null, "ui"));
  }
  if (p === "/areas" && m === "GET")
    return json({ areas: await vault.listAreas(), removed: await vault.removedAreas(), runs: await vault.areaRuns() });
  if ((r = p.match(/^\/areas\/([\w-]+)\/merge$/)) && m === "POST") return json(await vault.mergeArea(r[1], String((await body()).into ?? ""), "ui"));
  if ((r = p.match(/^\/areas\/([\w-]+)\/unblock$/)) && m === "POST") return json(await vault.unblockArea(r[1], "ui"));
  if ((r = p.match(/^\/areas\/([\w-]+)$/)) && m === "DELETE") return json(await vault.removeArea(r[1], "ui"));
  if (p === "/areas/undo-run" && m === "POST") return json(await vault.undoAreaRun(String((await body()).run ?? ""), "ui"));
  if (p === "/bulk" && m === "POST") {
    const b = await body();
    return json(await vault.bulkRemember({ items: Array.isArray(b.items) ? b.items : undefined, text: b.text, source: b.source ?? "ui paste", actor: "ui" }));
  }
  if (p === "/oauth/grants" && m === "GET") return json(await connectedApps(env, vault));
  if ((r = p.match(/^\/oauth\/grants\/([^/]+)$/)) && m === "DELETE") {
    const grantId = decodeURIComponent(r[1]);
    const app = ((await listConnectedApps(env)) as any[]).find((g) => g.grant_id === grantId);
    // Record first: from here on /mcp and refresh refuse this grant, even if KV is slow or a refresh writes it back.
    await vault.recordRevokedGrants([{ grant_id: grantId, client_id: app?.client_id }]);
    await env.OAUTH_PROVIDER.revokeGrant(grantId, OAUTH_USER_ID);
    // Also remove the dynamically registered client so its client_id can't be reused silently.
    if (qp.get("delete_client") === "1" && app) await env.OAUTH_PROVIDER.deleteClient(app.client_id);
    await vault.logAudit("oauth_revoke", "ui", { client_id: app?.client_id, client_name: app?.client_name, deleted_client: qp.get("delete_client") === "1" });
    return json({ ok: true });
  }
  if (p === "/oauth/clients" && m === "GET") {
    const res = await env.OAUTH_PROVIDER.listClients({ limit: 100 });
    return json(res.items.map((c) => ({ client_id: c.clientId, client_name: c.clientName, redirect_uris: c.redirectUris, registered_at: c.registrationDate ? new Date(c.registrationDate * 1000).toISOString() : null })));
  }
  if ((r = p.match(/^\/oauth\/clients\/([^/]+)$/)) && m === "DELETE") {
    const id = decodeURIComponent(r[1]);
    // Deleting a client also cuts off every grant it holds.
    const grants = ((await listConnectedApps(env)) as any[]).filter((g) => g.client_id === id);
    await vault.recordRevokedGrants(grants.map((g) => ({ grant_id: g.grant_id, client_id: id })));
    for (const g of grants) await env.OAUTH_PROVIDER.revokeGrant(g.grant_id, OAUTH_USER_ID);
    await env.OAUTH_PROVIDER.deleteClient(id);
    await vault.logAudit("oauth_delete_client", "ui", { client_id: id });
    return json({ ok: true });
  }
  if (p === "/batches" && m === "GET") return json(await vault.listBatches());
  if ((r = p.match(/^\/batches\/([\w-]+)\/undo$/)) && m === "POST") return json(await vault.undoBatch(r[1], "ui"));
  if (p === "/exclusions" && m === "GET") return json(await vault.listExclusions());
  if (p === "/audit" && m === "GET") return json(await vault.recentAudit(intParam(qp.get("limit"), 50, 1, 500)));
  // Full backup/restore (all state, ids and history), unlike /export which is for reading.
  if (p === "/backup" && m === "GET") {
    const backup = await vault.backup({ embeddings: qp.get("embeddings") !== "0" });
    return new Response(JSON.stringify(backup), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="frank-memory-backup-${backup.exported_at.slice(0, 10)}.json"` },
    });
  }
  if (p === "/restore" && m === "POST") return json(await vault.restore(await body(), { replace: qp.get("replace") === "1" }, "ui"));
  if (p === "/export" && m === "GET") {
    const fmt = qp.get("format") === "json" ? "json" : "md";
    return new Response(await vault.export(fmt), {
      headers: {
        "content-type": fmt === "json" ? "application/json" : "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="frank-memory-${new Date().toISOString().slice(0, 10)}.${fmt}"`,
      },
    });
  }
  return json({ error: "not found" }, 404);
}

/** Props attached to authenticated /mcp requests (set from the approved OAuth grant). */
interface McpProps { clientId?: string; clientName?: string }

/**
 * Connected apps, minus revoked grants. A refresh that raced a revoke can write a grant back into KV;
 * such a grant can't be used (see mcpApiHandler), and is revoked again here so it disappears.
 */
async function connectedApps(env: Env, vault: DurableObjectStub<MemoryVault>) {
  const revoked = new Set(await vault.revokedGrantIds());
  const apps = (await listConnectedApps(env)) as { grant_id: string }[];
  for (const a of apps.filter((a) => revoked.has(a.grant_id))) await env.OAUTH_PROVIDER.revokeGrant(a.grant_id, OAUTH_USER_ID);
  return apps.filter((a) => !revoked.has(a.grant_id));
}

/** Grant id from an access token issued by the provider ("userId:grantId:secret"). */
function grantIdOf(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const parts = h.replace(/^bearer\s+/i, "").split(":");
  return parts.length === 3 && parts[1] ? parts[1] : null;
}

/** /mcp: only reached after the OAuth provider validated an access token. */
const mcpApiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ((ctx as any).props ?? {}) as McpProps;
    const vault = vaultStub(env);
    // KV is eventually consistent and a refresh can race a revoke, so check the vault's own revoked list.
    const grantId = grantIdOf(req);
    if (!grantId || (await vault.isGrantRevoked(grantId)))
      return new Response(JSON.stringify({ error: "invalid_token", error_description: "This app's access was revoked. Connect it again to continue." }), {
        status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' },
      });
    const allowedHostnames = mcpAllowedHostnames(env);
    return createMcpHandler(() => buildMcpServer(vault, { client: props.clientName, ownerName: env.OWNER_NAME }), {
      route: "/mcp",
      ...(allowedHostnames?.length ? { allowedHostnames } : {}),
    })(req, env, ctx);
  },
};

/** Everything else: UI, /api/*, /authorize (Access: owner or service-token script), and public /health, /connect, metadata. */
const appHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/connect" && req.method === "GET")
      return new Response(connectInstructions(publicBase(env, req), env.OWNER_NAME), {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    // RFC 9728 puts metadata at /.well-known/oauth-protected-resource/mcp (served by the provider).
    // Some clients probe the root form too, so serve the same document there.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      const base = publicBase(env, req);
      return new Response(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], resource_name: resourceName(env) }),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
    if (!signInConfigured(req, env))
      return json({ error: "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN, ACCESS_AUD and ACCESS_ALLOWED_EMAILS (or DEV_OWNER_EMAIL for local dev)" }, 503);

    const caller = await resolveCaller(req, env);
    const owner = caller?.kind === "owner" ? caller.name : null;
    const audit = (action: string, actor: string, details: unknown) => vaultStub(env).logAudit(action, actor, details);

    // Approving an app needs a person; a service token can't.
    if (url.pathname === "/authorize") return handleAuthorize(req, env, { signedInAs: owner, audit });

    if (!caller) {
      if (url.pathname === "/" && req.method === "GET") return html(SIGN_IN_PAGE, 401);
      return json({ error: "unauthorized" }, 401);
    }

    const vault = vaultStub(env);
    if (url.pathname.startsWith("/api/")) {
      // CSRF hardening for browser callers: same-origin only for state-changing calls; browsers must send Origin.
      const origin = req.headers.get("origin");
      if (req.method !== "GET" && caller.kind === "owner" && origin !== url.origin) return json({ error: "bad origin" }, 403);
      return api(req, url, vault, env);
    }
    if (url.pathname === "/" && req.method === "GET") {
      if (caller.kind !== "owner") return json({ error: "the dashboard is for signed-in people, not service tokens" }, 403);
      return html(renderUi());
    }
    return json({ error: "not found" }, 404);
  },
};

const resourceName = (env: Env) => fillOwner("frank-memory ({owner's} memory vault)", env.OWNER_NAME);

/** Canonical origin: PUBLIC_URL when set, else the origin this request arrived on. */
function publicBase(env: Env, req: Request): string {
  return (env.PUBLIC_URL?.trim() || new URL(req.url).origin).replace(/\/+$/, "");
}
/** Hostnames /mcp accepts: PUBLIC_URL's host plus MCP_ALLOWED_HOSTNAMES; undefined keeps the SDK default (localhost, workers.dev). */
function mcpAllowedHostnames(env: Env): string[] | undefined {
  const list = (env.MCP_ALLOWED_HOSTNAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.PUBLIC_URL?.trim()) list.unshift(new URL(env.PUBLIC_URL.trim()).hostname);
  return list.length ? [...new Set(list)] : undefined;
}

const providers = new Map<string, OAuthProvider<Env>>();
function getProvider(env: Env, req: Request): OAuthProvider<Env> {
  const base = publicBase(env, req);
  const cached = providers.get(base);
  if (cached) return cached;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler as any,
    defaultHandler: appHandler as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // Client ID Metadata Documents (URL client_ids), used by Codex and newer MCP clients; DCR stays available.
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 60 * 60, // 1h
    refreshTokenTTL: 60 * 60 * 24 * 90, // 90d
    resourceMetadata: { resource: `${base}/mcp`, resource_name: resourceName(env) },
    // A revoked app can't refresh its way back in (invalid_grant also makes the library revoke the grant again).
    tokenExchangeCallback: async ({ grantType, grantId, env }) => {
      if (grantType === GrantType.REFRESH_TOKEN && (await vaultStub(env as Env).isGrantRevoked(grantId)))
        throw new OAuthError("invalid_grant", { description: "This app's access was revoked." });
    },
  });
  providers.set(base, provider);
  return provider;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env, req).fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
