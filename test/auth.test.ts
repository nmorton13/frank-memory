import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { devOwner, resolveCaller, signInConfigured } from "../src/auth";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "aud-tag";
const access = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: "owner@example.com", ACCESS_SERVICE_TOKENS: "backup.access" } as any;
let sign: (claims: Record<string, unknown>, opts?: { aud?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (url: string | URL) =>
    String(url) === `${TEAM}/cdn-cgi/access/certs` ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 }));
  sign = (claims, o = {}) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? TEAM).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
});
afterAll(() => { vi.unstubAllGlobals(); });

const req = (url = "https://memory.example.com/api/settings", headers: Record<string, string> = {}) => new Request(url, { headers });
const withJwt = async (claims: Record<string, unknown>, o?: { aud?: string; iss?: string }) =>
  req(undefined, { "cf-access-jwt-assertion": await sign(claims, o) });

describe("resolveCaller (Access only, no vault token)", () => {
  it("accepts an allowed person as owner", async () => {
    expect(await resolveCaller(await withJwt({ email: "Owner@Example.com" }), access)).toEqual({ kind: "owner", name: "owner@example.com" });
  });
  it("accepts an allowed service token as a script, never as owner", async () => {
    expect(await resolveCaller(await withJwt({ common_name: "backup.access" }), access)).toEqual({ kind: "script", name: "service token backup.access" });
  });
  it("refuses other people, other service tokens and JWTs for another application", async () => {
    expect(await resolveCaller(await withJwt({ email: "someone@example.com" }), access)).toBeNull();
    expect(await resolveCaller(await withJwt({ common_name: "other.access" }), access)).toBeNull();
    expect(await resolveCaller(await withJwt({ email: "owner@example.com" }, { aud: "other-app" }), access)).toBeNull();
    expect(await resolveCaller(await withJwt({ email: "owner@example.com" }, { iss: "https://evil.cloudflareaccess.com" }), access)).toBeNull();
  });
  it("gives a bearer token no access at all", async () => {
    const env = { ...access, VAULT_TOKEN: "old-secret" };
    expect(await resolveCaller(req(undefined, { authorization: "Bearer old-secret" }), env)).toBeNull();
  });
});

describe("sign-in configuration", () => {
  it("refuses to serve owner routes without Access, except local dev", () => {
    expect(signInConfigured(req(), {} as any)).toBe(false);
    expect(signInConfigured(req(), access)).toBe(true);
    expect(signInConfigured(req("http://localhost:8787/"), { DEV_OWNER_EMAIL: "dev@example.com" } as any)).toBe(true);
  });
  it("honors DEV_OWNER_EMAIL only on localhost with a local (or unset) PUBLIC_URL", async () => {
    const dev = { DEV_OWNER_EMAIL: "dev@example.com" } as any;
    expect(devOwner(req("http://localhost:8787/"), dev)).toBe("dev@example.com");
    expect(devOwner(req("http://127.0.0.1:8787/"), dev)).toBe("dev@example.com");
    expect(devOwner(req("https://memory.example.com/"), dev)).toBeNull();
    expect(devOwner(req("http://localhost:8787/"), { ...dev, PUBLIC_URL: "https://memory.example.com" })).toBeNull();
    expect(await resolveCaller(req("http://localhost:8787/"), dev)).toEqual({ kind: "owner", name: "dev@example.com" });
    expect(await resolveCaller(req("https://memory.example.com/"), dev)).toBeNull();
  });
});
