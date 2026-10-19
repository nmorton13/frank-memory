// OAuth 2.1 authorization UI for frank-memory (single user: the vault owner).
// The protocol endpoints (/token, /register, discovery metadata, PKCE checks) are handled by
// @cloudflare/workers-oauth-provider; this file only renders/handles the consent step at /authorize.
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { fillOwner } from "./helpers";

export const OAUTH_USER_ID = "owner";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string, status = 200, headers?: Headers) {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set("content-security-policy", "frame-ancestors 'none'");
  h.set("referrer-policy", "no-referrer");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>frank-memory · authorize</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:460px;margin:3rem auto;padding:0 1rem;color:#111827}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:1.4rem}h1{font-size:1.2rem;margin:0 0 .8rem}
.meta{color:#6b7280;font-size:13px}.warn{background:#fef3c7;color:#92400e;padding:.5rem .7rem;border-radius:8px;font-size:13px}
.err{background:#fee2e2;color:#991b1b;padding:.5rem .7rem;border-radius:8px;font-size:13px}
input{width:100%;font:inherit;padding:.5rem;border:1px solid #e5e7eb;border-radius:8px;box-sizing:border-box}
.row{display:flex;gap:.6rem;margin-top:1rem}button{flex:1;font:inherit;padding:.55rem;border-radius:8px;border:1px solid #e5e7eb;background:#fff;cursor:pointer}
button.p{background:#2563eb;color:#fff;border-color:#2563eb}code{font-size:12px;word-break:break-all}</style></head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: h },
  );
}

function errorPage(msg: string, status = 400) {
  return page(`<h1>Can't authorize</h1><p class="err">${esc(msg)}</p>`, status);
}

async function consentPage(env: Env, req: Request, authReq: AuthRequest, handle: string, signedInAs: string, error?: string, headers?: Headers) {
  const d = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const action = "/authorize" + new URL(req.url).search;
  return page(
    `<h1>Connect <b>${esc(d.clientName)}</b> to frank-memory?</h1>
<p>This app will be able to <b>read and write ${esc(fillOwner("{owner's}", env.OWNER_NAME))} memory vault</b> through MCP (recall, remember, import, forget).</p>
<p class="meta">Client ID: <code>${esc(d.clientId)}</code>${d.clientDomain ? `<br>Verified domain: <b>${esc(d.clientDomain)}</b>` : "<br>Client name is self-declared (dynamic registration)."}
<br>Tokens are sent to: <b>${esc(d.redirectHost)}</b>${d.scope.length ? `<br>Scopes: ${esc(d.scope.join(" "))}` : ""}</p>
${d.redirectIsLoopback ? `<p class="warn">The redirect goes to a local app on this computer. Approve only if you just started this connection.</p>` : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${esc(action)}">
<input type="hidden" name="handle" value="${esc(handle)}">
<p class="meta">Signed in as <b>${esc(signedInAs)}</b>.</p>
<div class="row"><button name="decision" value="deny">Deny</button><button class="p" name="decision" value="approve">Approve</button></div>
</form>`,
    error ? 401 : 200,
    headers,
  );
}

export async function handleAuthorize(
  req: Request,
  env: Env,
  opts: {
    /** The signed-in owner (Access email, or DEV_OWNER_EMAIL locally); null if nobody. */
    signedInAs: string | null;
    audit: (action: string, actor: string, details: unknown) => Promise<unknown>;
  },
): Promise<Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (e) {
    return errorPage((e as Error).message || "Invalid authorization request");
  }
  // OAuth 2.1 / MCP: PKCE with S256 is mandatory (the provider rejects 'plain'; we also reject a missing challenge).
  if (!authReq.codeChallenge || authReq.codeChallengeMethod !== "S256")
    return errorPage("PKCE with code_challenge_method=S256 is required.");
  // Behind Cloudflare Access every request here carries an identity; without one, refuse.
  if (!opts.signedInAs) return errorPage("Sign in through Cloudflare Access to approve apps.", 401);
  const signedInAs = opts.signedInAs;

  if (req.method === "GET") {
    const tx = await env.OAUTH_PROVIDER.beginConsent(authReq);
    return consentPage(env, req, authReq, tx.handle, signedInAs, undefined, tx.headers);
  }
  if (req.method !== "POST") return errorPage("Method not allowed", 405);

  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return errorPage("Cross-site form post rejected", 403);
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  const decision = String(form.get("decision") ?? "");
  // Who is being approved comes only from the consent transaction (bound to this browser by cookie and
  // shown on the page), never from this POST's query string, which a crafted form could change.
  const nameOf = async (clientId: string) => (await env.OAUTH_PROVIDER.lookupClient(clientId))?.clientName || clientId;

  try {
    if (decision !== "approve") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(req, handle);
      const clientId = denied.request.clientId;
      await opts.audit("oauth_deny", `oauth:${await nameOf(clientId)}`, { client_id: clientId });
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(req, handle);
    const { clientId, redirectUri, scope } = approved.request;
    const clientName = await nameOf(clientId);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: OAUTH_USER_ID,
      scope,
      metadata: { clientName, approvedAt: new Date().toISOString() },
      props: { clientId, clientName },
    });
    await opts.audit("oauth_grant", `oauth:${clientName}`, { approved_by: signedInAs, client_id: clientId, redirect_host: new URL(redirectUri).host || redirectUri });
    const h = new Headers(approved.headers);
    h.set("location", redirectTo);
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    return errorPage((e as Error).message || "Authorization failed");
  }
}

/** Grants + client names for the UI "Connected apps" section. */
export async function listConnectedApps(env: Env) {
  const out: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(OAUTH_USER_ID, { cursor, limit: 100 } as any);
    for (const g of page.items) {
      const c = await env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
      out.push({
        grant_id: g.id, client_id: g.clientId, client_name: c?.clientName || g.metadata?.clientName || g.clientId,
        client_uri: c?.clientUri, redirect_uri: g.redirectUri, scope: g.scope,
        created_at: new Date(g.createdAt * 1000).toISOString(),
        expires_at: g.expiresAt ? new Date(g.expiresAt * 1000).toISOString() : null,
      });
    }
    cursor = (page as any).cursor;
  } while (cursor);
  return out;
}
