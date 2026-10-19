import type { MemoryVault } from "./vault";

export interface Env {
  MEMORY_VAULT: DurableObjectNamespace<MemoryVault>;
  VECTORIZE: Vectorize;
  AI: Ai;
  OAUTH_KV: KVNamespace;
  /** Injected by @cloudflare/workers-oauth-provider into the default handler's env. */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  /** Canonical public origin, e.g. https://memory.example.com. Optional; defaults to the request origin. */
  PUBLIC_URL?: string;
  /** Optional comma-separated hostnames for /mcp when served on a custom domain. */
  MCP_ALLOWED_HOSTNAMES?: string;
  /** Cloudflare Access team domain, e.g. https://frank.cloudflareaccess.com. Required with ACCESS_AUD and ACCESS_ALLOWED_EMAILS: Access is the only sign-in. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application that protects the browser paths. */
  ACCESS_AUD?: string;
  /** Comma-separated emails allowed to use the UI and approve OAuth clients. */
  ACCESS_ALLOWED_EMAILS?: string;
  /** Comma-separated Access service-token client IDs allowed to call /api/* (scripts such as backups). */
  ACCESS_SERVICE_TOKENS?: string;
  /** Local development only: treat localhost requests as this owner, since Access can't sit in front of localhost. */
  DEV_OWNER_EMAIL?: string;
  /** Owner's name shown to agents and on the approval page, e.g. "Sam". Defaults to "the vault owner". */
  OWNER_NAME?: string;
}
