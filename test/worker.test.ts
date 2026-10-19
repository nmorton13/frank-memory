import { describe, expect, it } from "vitest";
import { createWorker } from "./support/worker-harness";

const listedGrants = async (w: ReturnType<typeof createWorker>) => ((await (await w.api("/oauth/grants")).json()) as { grant_id: string }[]).map((g) => g.grant_id);
const revoke = (w: ReturnType<typeof createWorker>, grantId: string) => w.api(`/oauth/grants/${grantId}`, "DELETE");

describe("OAuth through the real Worker", () => {
  it("connects an app and serves MCP; there is no static-token fallback", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    expect(await w.mcp(app.access)).toBe(200);
    expect(await w.mcp("some-static-token")).toBe(401);
  });
});

describe("revoking an app (review #1)", () => {
  it("cuts off the app at once, even while KV still holds its grant and tokens", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    const snapshot = new Map(w.kv.data);
    expect((await revoke(w, app.grantId)).status).toBe(200);
    // Simulate KV propagation lag: another location still serves the old grant and tokens.
    for (const [k, v] of snapshot) if (k.startsWith("grant:") || k.startsWith("token:")) w.kv.data.set(k, v);

    expect(await w.mcp(app.access)).toBe(401);
    const r = await w.refresh(app);
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await listedGrants(w)).toEqual([]);
  });

  it("a refresh that read the grant before the revoke can't bring the app back", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    const paused = w.kv.pauseNext("get", "grant:");
    const refreshing = w.refresh(app);
    await paused.reached;
    await revoke(w, app.grantId);
    paused.release();
    expect(await refreshing).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await listedGrants(w)).toEqual([]);
  });

  it("a refresh that writes its new token after the revoke gets a token that /mcp refuses (the reviewed race)", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    const paused = w.kv.pauseNext("put", "token:");
    const refreshing = w.refresh(app);
    await paused.reached; // the refresh is past its checks and about to store the new tokens
    await revoke(w, app.grantId);
    paused.release();

    const r = await refreshing;
    expect(r.status).toBe(200); // the library still hands out a token...
    expect(await w.mcp(r.body.access_token)).toBe(401); // ...but it can't be used
    expect(await listedGrants(w)).toEqual([]); // and the resurrected grant is hidden and revoked again
    expect([...w.kv.data.keys()].some((k) => k.startsWith(`grant:`) && k.includes(app.grantId))).toBe(false);
  });

  it("deleting a client revokes every grant it holds", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    const other = await w.connect("Other App");
    expect((await w.api(`/oauth/clients/${encodeURIComponent(app.client_id)}`, "DELETE")).status).toBe(200);
    expect(await w.mcp(app.access)).toBe(401);
    expect(await w.mcp(other.access)).toBe(200);
  });
});

describe("OAuth attribution (review #16)", () => {
  it("takes the app's identity from the approved consent, not from the POST's query", async () => {
    const w = createWorker();
    const a = await w.register("App A");
    const b = await w.register("App B");
    const qa = await w.authQuery(a.client_id);
    const qb = await w.authQuery(b.client_id);
    // You approve App A's consent page, but the form is posted with App B's query string.
    const code = await w.approve(await w.openConsent(qa.q), qb.q);
    const t = await w.token({ grant_type: "authorization_code", code, client_id: a.client_id, redirect_uri: "http://localhost:9999/callback", code_verifier: qa.verifier, resource: "http://localhost:8787/mcp" });
    expect(t.status).toBe(200);

    const audit = w.h.db.prepare(`SELECT actor, details FROM audit WHERE action = 'oauth_grant'`).get() as any;
    expect(audit.actor).toBe("oauth:App A");
    expect(JSON.parse(audit.details).client_id).toBe(a.client_id);

    // Writes over this token are attributed to App A.
    const r = await w.call("/mcp", { method: "POST", headers: { authorization: `Bearer ${t.body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { content: "Sam likes figs", source: "test" } } }) });
    expect(r.status).toBe(200);
    await r.text();
    expect(w.h.db.prepare(`SELECT source FROM memories`).get()).toEqual({ source: "test (via App A)" });
  });
});

describe("newer default guide notice", () => {
  const guideText = async (w: ReturnType<typeof createWorker>, access: string) => {
    const r = await w.call("/mcp", { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_operating_guide", arguments: {} } }) });
    return r.text();
  };

  it("get_operating_guide and the dashboard mention a newer default until the owner saves", async () => {
    const w = createWorker();
    const app = await w.connect("Test App");
    expect(await guideText(w, app.access)).not.toContain("Newer default guide available");
    expect(await (await w.api("/guide")).json()).toMatchObject({ newer_default: false });

    w.h.db.prepare(`UPDATE operating_guide SET content = ?`).run("# Older default guide");
    expect(await guideText(w, app.access)).toContain("Newer default guide available: mention it to Sam once this session");
    expect(await (await w.api("/guide")).json()).toMatchObject({ newer_default: true });

    expect((await w.api("/guide", "PUT", { content: "# Sam's guide" })).status).toBe(200);
    expect(await guideText(w, app.access)).not.toContain("Newer default guide available");
  });
});
