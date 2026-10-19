// Who is calling the owner routes (UI, /api/*, /authorize). Cloudflare Access is the only way in:
//  - a person Access signed in with an allowed email -> owner
//  - a script presenting an allowed Access service token -> script (can call /api/*, can't approve apps)
//  - local development only: DEV_OWNER_EMAIL on a localhost request -> owner (Access can't front localhost)
// /mcp is separate: the OAuth provider authenticates it with per-app tokens.
import { accessConfigured, accessIdentity } from "./access";
import type { Env } from "./env";

export type Caller = { kind: "owner" | "script"; name: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLocal = (url: string) => LOCAL_HOSTS.has(new URL(url).hostname);

/**
 * DEV_OWNER_EMAIL, when this is a localhost request to a local configuration. A deployed Worker is only
 * reached through its real hostname, never localhost; as a second guard it's ignored when PUBLIC_URL names a
 * non-local origin.
 */
export function devOwner(req: Request, env: Env): string | null {
  const email = env.DEV_OWNER_EMAIL?.trim();
  if (!email || !isLocal(req.url)) return null;
  if (env.PUBLIC_URL?.trim() && !isLocal(env.PUBLIC_URL.trim())) return null;
  return email;
}

/** True when some sign-in method is available for this request (otherwise the owner routes refuse to serve). */
export function signInConfigured(req: Request, env: Env): boolean {
  return accessConfigured(env) || !!devOwner(req, env);
}

export async function resolveCaller(req: Request, env: Env): Promise<Caller | null> {
  const id = await accessIdentity(req, env);
  if (id) return "email" in id ? { kind: "owner", name: id.email } : { kind: "script", name: `service token ${id.serviceToken}` };
  const dev = devOwner(req, env);
  return dev ? { kind: "owner", name: dev } : null;
}
