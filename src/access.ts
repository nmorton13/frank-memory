// Cloudflare Access identity for the owner routes (UI, /api/*, /authorize).
// Access sits in front of those paths and adds a signed JWT in the Cf-Access-Jwt-Assertion header.
// The Worker verifies it itself (signature, issuer, audience, expiry, allowed email or service token), so a
// request that reaches the Worker without going through Access (for example via workers.dev) is still refused.
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { listIncludes } from "./helpers";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFor = "";

/** Team domain normalized to "https://<team>.cloudflareaccess.com" (no trailing slash). */
function teamDomain(env: Env): string {
  const d = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  return d && !/^https?:\/\//.test(d) ? `https://${d}` : d;
}

export function accessConfigured(env: Env): boolean {
  return !!(teamDomain(env) && env.ACCESS_AUD && env.ACCESS_ALLOWED_EMAILS);
}

/** An allowed person (by email), or an allowed Access service token (by client ID) for scripts. */
export type AccessIdentity = { email: string } | { serviceToken: string };

/** Returns the request's Access identity, or null when it has no valid, allowed one. */
export async function accessIdentity(req: Request, env: Env): Promise<AccessIdentity | null> {
  if (!accessConfigured(env)) return null;
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const issuer = teamDomain(env);
  if (!jwks || jwksFor !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksFor = issuer;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"] });
    if (listIncludes(payload.email, env.ACCESS_ALLOWED_EMAILS)) return { email: String(payload.email).toLowerCase() };
    // Service-token JWTs carry the token's client ID as common_name and no email.
    if (!payload.email && listIncludes(payload.common_name, env.ACCESS_SERVICE_TOKENS)) return { serviceToken: String(payload.common_name) };
    return null;
  } catch (e) {
    console.warn("access jwt rejected:", (e as Error).message);
    return null;
  }
}
