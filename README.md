# frank-memory

One long-term memory for all your AI agents. Claude, ChatGPT, Cursor, Codex, and anything else that speaks MCP connect to the same vault, so what one agent learns about you and your projects, the next one can recall. You own it: it runs in your own Cloudflare account, you sign in with Cloudflare Access, and you can review, edit, export, back up, or delete every memory from a web dashboard.

- **For agents:** seven MCP tools (recall, remember, bulk import, forget, …) and an Operating Guide you control, which tells every agent when to recall, what's worth saving, and what never to save.
- **For you:** an approval queue (or auto mode), undoable imports, near-duplicate and conflict detection, secret rejection, full backup and restore, and per-app OAuth connections you can revoke.
- **Cost:** personal use should fit within Cloudflare's free tiers (Workers, SQLite Durable Objects, Vectorize, Workers AI, KV, and Access for up to 50 users). Check current limits for your account.

The design follows [Notion's agent memory setup](https://developers.notion.com/prompts/setup), as a self-hosted vault. Quick start: [Setup](#setup), then give each agent `https://<your-host>/connect`.

## How it works

It runs on Cloudflare:

- **OAuth 2.1** (`@cloudflare/workers-oauth-provider`, state in KV `OAUTH_KV`) protects `/mcp`: every app gets its own revocable tokens.
- **Cloudflare Access** is the only way into the UI at `/`, JSON at `/api/*`, and the app-approval page. There is no shared vault password or static token.
- **Worker** (TypeScript) handles routing; the UI at `/`, JSON at `/api/*`, and MCP at `/mcp`.
- **Durable Object** `MemoryVault` (SQLite backend) is one vault (`getByName("personal")`). It holds memories, an FTS5 index, the Operating Guide and its history, settings, exclusions, import batches, and an audit log.
- **Vectorize** `frank-memory-index` (768 dims, cosine) plus **Workers AI** `@cf/baai/bge-base-en-v1.5` provide embeddings.
- **MCP**: a stateless Streamable HTTP server via the Agents SDK `createMcpHandler` (`agents/mcp/server`, MCP SDK v2 `@modelcontextprotocol/server`).

Recall is hybrid. Vectorize returns the 20 best eligible semantic matches (from 100 candidates), and FTS5 bm25 returns the 20 best eligible keyword matches (stopwords like "what" and "at" are ignored). Each hit is scored by its actual cosine similarity (75%) and its keyword strength relative to the best keyword hit (25%). Active status and recency only nudge near-ties, so a strongly matching *proposed* memory still outranks a weak *active* one. Superseded and rejected items are excluded unless you ask for them. **If Workers AI or Vectorize is unavailable (for example in local dev), writes still succeed and recall falls back to keyword-only** (`mode: "keyword-only"`).

## MCP tools
`get_operating_guide`, `recall`, `remember`, `propose_memory`, `bulk_remember`, `list_memories`, `forget`.

## Approval mode
- `review` (default): agent writes are stored as `proposed` and wait in the UI queue.
- `auto`: agent writes are stored as `active`, including superseding writes (the old memory becomes `superseded` history). `propose_memory` still queues for review.
- In review mode superseding writes stay `proposed`. In both modes, secret-looking content is rejected and **not stored**.

## History retention
A daily Durable Object alarm removes history past its retention period, set in the dashboard's **History** section (0 = keep forever):
- **Superseded** memories: 365 days after they were replaced.
- **Rejected** memories: 30 days. The content hash is kept as an exclusion so the same text isn't re-imported.
- **Audit log** entries: 365 days.

Active and proposed memories are never removed. **Clean up now** runs it immediately.

## Backup and restore
**Download backup** (dashboard, or `GET /api/backup`) saves the whole vault as one JSON file: every memory, including rejected and superseded ones, with its id, timestamps, replacement links, import batch and embedding; forget exclusions; import batches; the guide and its version history; settings; and the audit log. `?embeddings=0` leaves embeddings out (smaller file; they are recomputed on restore). **Export MD/JSON** is a readable copy, not a backup.

**Restore from file** (`POST /api/restore`) fills an empty vault in one transaction: either all of it is restored or nothing changes. A vault that already has memories is only replaced with `?replace=1` (the dashboard asks first). Content hashes are recomputed; an embedding is kept only if it matches the content and the current embedding model, otherwise that memory is re-embedded. Vectorize is rebuilt in the background through the index queue. OAuth grants live in KV and are not in the backup, so reconnect apps after restoring to a new deployment.

Keep backups outside Cloudflare. `scripts/backup.sh` downloads one with an Access service token (setup step 4 above) and checks it is complete: `FM_URL=… CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… scripts/backup.sh ~/backups`. Cloudflare's 30-day SQLite point-in-time recovery is a second line of defense, but it doesn't cover Vectorize or the OAuth KV.

## Imports and duplicates
Imports (`bulk_remember`, `POST /api/bulk`, UI paste) go in under one undoable `batch_id`. Importing the same memories from several agents is expected, so each item is checked in turn:
1. **Exact duplicates** (ignoring case and whitespace), **forgotten** items, and **secret-like** items are skipped.
2. Each item is embedded and compared with existing active, proposed, and superseded memories, and with earlier items in the same import:
   - **Near-duplicate:** skipped. This needs cosine ≥ 0.93 *and* the same numbers, versions, IPs, dates, and negations.
   - **Similar:** cosine ≥ 0.80. These may be an update or a contradiction, so they're linked (`similar_to`) and stored `proposed` in review mode. In auto mode they're stored `active` and flagged: `recall` shows `may_conflict_with` while both are active, and agents settle it with the guide's conflict rules. The review queue shows both memories, with **Approve**, **Approve & replace old** (the old one becomes superseded), or **Reject**.
   - **Everything else:** stored `active`.

The thresholds are in `src/helpers.ts`. They were calibrated on the live vault: rewordings scored 0.90–0.98; contradictions such as "1 Gbps" vs "2 Gbps" scored 0.85–0.89; a changed date scored 0.99. That last case is why number and negation changes always go to review. If Workers AI is unavailable, only exact duplicates are caught, and the result says so.

## Setup

```bash
npm install
npx wrangler login
npx wrangler vectorize create frank-memory-index --dimensions=768 --metric=cosine
npx wrangler kv namespace create OAUTH_KV  # replace the id in wrangler.jsonc with the one it prints
npx wrangler deploy                         # then set up Cloudflare Access (below); until then the UI refuses to serve
```

Per-deployment settings are **Worker secrets**, so nothing personal is committed:

| Secret | |
|---|---|
| `PUBLIC_URL` | Canonical origin, e.g. `https://memory.example.com`. It's the OAuth issuer and MCP resource id, and the only host `/mcp` accepts. If unset, each request's own origin is used. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_ALLOWED_EMAILS` | Required. Cloudflare Access sign-in (below). |
| `ACCESS_SERVICE_TOKENS` | Optional. Client IDs of Access service tokens that scripts (such as `scripts/backup.sh`) may use on `/api/*` (comma list). A service token can call the API but can't approve apps or open the dashboard. |
| `OWNER_NAME` | Your name as agents and the approval page show it ("Sam's memory vault"). Defaults to "the vault owner". The default Operating Guide uses it only when a new vault is created; after that, edit the guide in the UI. When a deploy ships a newer default guide, `get_operating_guide` tells agents to mention it and the dashboard points to **Load latest default**, until you save a guide from the dashboard. |
| `MCP_ALLOWED_HOSTNAMES` | Optional extra hostnames for `/mcp` (comma list). |

**Custom domain:** run `npx wrangler deploy --domain memory.example.com` once, or add it in the dashboard: Worker → Settings → Domains & Routes. Then run `npx wrangler secret put PUBLIC_URL` with `https://memory.example.com`. `wrangler.jsonc` turns off `workers.dev` and preview URLs, so the Worker is reachable only on your domain. To deploy on `workers.dev` instead, set `"workers_dev": true` and skip `PUBLIC_URL`.

### Sign-in (Cloudflare Access)
The UI, `/api/*`, and the OAuth approval page sit behind Access, so you sign in with Google, GitHub, or an emailed code. The Worker verifies the Access JWT itself (signature, issuer, audience, expiry, allowed email or service token), so requests that skip Access, for example via `workers.dev`, are refused. Without the Access secrets, the Worker serves only `/mcp`, OAuth metadata, `/health` and `/connect`. Setup:
1. Zero Trust → Access → Applications → **Add** → **Self-hosted**. Name it `frank-memory`, and set the domain to your custom domain with no path. Add a policy: **Allow** → Emails → your email.
2. Add a second self-hosted application for the agent endpoints, with a **Bypass** → Everyone policy. Its paths are `mcp`, `token`, `register`, `.well-known`, `health`, and `connect`. `/mcp` stays protected by OAuth in the Worker; the others hold no vault content.
3. Copy the first app's **Application Audience (AUD) tag**, then set the secrets: `ACCESS_TEAM_DOMAIN` (`https://<team>.cloudflareaccess.com`), `ACCESS_AUD`, and `ACCESS_ALLOWED_EMAILS` (your email).
4. Optional, for scripts: Zero Trust → Access → **Service credentials** → create a service token. On the first app, add a **Service Auth** policy that includes it, and put its client ID in `ACCESS_SERVICE_TOKENS`.

**Sign out** in the dashboard ends the Access session (`/cdn-cgi/access/logout`).

### Local dev
```bash
cp .dev.vars.example .dev.vars   # set DEV_OWNER_EMAIL
npm run dev                      # http://localhost:8787, signed in as DEV_OWNER_EMAIL
```
Access can't sit in front of localhost, so `DEV_OWNER_EMAIL` signs localhost requests in as the owner. It only applies to requests addressed to `localhost`/`127.0.0.1`, and is ignored when `PUBLIC_URL` names a real domain, so it can't open a deployed vault. Don't set it as a Worker secret.
Vectorize is not supported locally, so recall runs keyword-only unless you set `"remote": true` on the `vectorize` binding. Workers AI runs remotely when wrangler is logged in, so bulk-import duplicate detection works locally.

### Seeding
Import a file from the dashboard's paste box, through an agent's `bulk_remember`, or from a script with an Access service token:
```bash
printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" |
  curl -X POST "https://memory.example.com/api/bulk" -H @- -H 'content-type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"text":open(sys.argv[1]).read(),"source":"chatgpt-export"}))' memories.md)"
```
Accepted formats: markdown or plain text in `text` (split on `---`, blank-line paragraphs, or bullet lines), or `items`: a list of strings or `{content,type?,source?,source_date?}` objects.

## Connecting MCP clients

**Quickest:** give the agent `https://memory.example.com/connect` and ask it to follow the instructions there. That page is plain markdown written for agents. It covers connecting the MCP server in its app, saving standing instructions, and importing the app's saved memories (the guide points agents back there for reruns). It holds no vault content, and connecting still needs you to sign in and approve on the OAuth page. With Cloudflare Access, add `connect` to the bypass app so agents can read it.

Endpoint: **`https://memory.example.com/mcp`** (Streamable HTTP).

Apps authenticate with **OAuth 2.1 + PKCE**. Paste the URL into the client, then sign in and approve. Clients discover everything automatically from the 401 `WWW-Authenticate` header → `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`. They register with dynamic client registration (`/register`) or a Client ID Metadata Document, and then use `/authorize` and `/token` with S256 PKCE. Access tokens last 1 hour; refresh tokens last 90 days.
The **approval page** names the client and the host its tokens are sent to. You're signed in through Access, so you just click Approve or Deny. There is no static token: a client that can't do OAuth can use `npx mcp-remote` (below).

Memories written over OAuth are tagged with the client's name: the `source` becomes `"<source> (via Claude)"` and the audit actor becomes `mcp:Claude`. Grants, denials, and revocations are recorded in the audit log. **Connected apps** in the UI lists OAuth grants and lets you revoke them.

### Claude (claude.ai / Claude Desktop)
Settings → **Connectors** → **Add custom connector** → Name `frank-memory`, URL `https://memory.example.com/mcp` → **Add** → **Connect**. A browser tab opens the frank-memory approval page (sign in through Access if asked), then click **Approve**. Leave OAuth client ID/secret blank; Claude registers itself. Custom connectors added on claude.ai also show up in Claude Desktop.

### Claude Code
```bash
claude mcp add --transport http --scope user frank-memory https://memory.example.com/mcp
```
Then run `/mcp` inside Claude Code → select **frank-memory** → **Authenticate** → approve in the browser.

### OpenAI Codex (CLI, IDE extension, ChatGPT desktop app share `~/.codex/config.toml`)
```toml
[mcp_servers.frank-memory]
url = "https://memory.example.com/mcp"
```
then:
```bash
codex mcp login frank-memory      # opens the browser → approve
codex mcp list                    # should show frank-memory as authenticated
```
Or run `codex mcp add frank-memory --url https://memory.example.com/mcp` followed by `codex mcp login frank-memory`. Codex uses the CIMD client `https://chatgpt.com/oauth/codex/client.json` (shown as "Codex", verified domain chatgpt.com) or falls back to DCR. Loopback callbacks with variable ports are accepted. In the IDE extension or ChatGPT desktop app, go to MCP servers → Add server → Streamable HTTP → URL → **Authenticate**.

### Cursor (`~/.cursor/mcp.json`)
OAuth: `{ "mcpServers": { "frank-memory": { "url": "https://memory.example.com/mcp" } } }`. Cursor shows a "Needs login" button that runs the OAuth flow.

### Other clients (Muse, MCP Inspector, mcp-remote, …)
Any client that implements the MCP authorization spec should work with just the URL. For clients that only support stdio, or only a fixed header, use `npx mcp-remote https://memory.example.com/mcp`, which does the OAuth flow in a browser.

**ChatGPT (web):** custom MCP connectors depend on the ChatGPT plan and developer mode.

### Verifying OAuth
Connect an app (for example `claude mcp add …` then `/mcp` → Authenticate), check its tools work, then revoke it under **Connected apps** and confirm it's asked to sign in again.

## HTTP API (Access identity: you, or an allowed service token)
`GET/PUT /api/guide` · `GET/PUT /api/settings` · `GET/POST /api/memories` · `PATCH/DELETE /api/memories/:id` · `POST /api/memories/:id/{approve,reject,forget}` (`approve?supersede_similar=1` replaces the similar memory) · `GET /api/recall?q=` · `POST /api/bulk` · `GET /api/batches` · `POST /api/batches/:id/undo` · `GET /api/exclusions` · `GET /api/audit` · `GET /api/export?format=md|json` · `GET /api/backup` · `POST /api/restore?replace=1` · `POST /api/reindex?reembed=1` · `GET /api/oauth/grants` · `DELETE /api/oauth/grants/:id` · `GET /api/oauth/clients` · `DELETE /api/oauth/clients/:id` · `GET /health` and `GET /connect` (public).

## Scripts
`npm run dev` · `npm run deploy` · `npm run deploy:dry` · `npm run typecheck` · `npm test` · `scripts/backup.sh` (download a backup with an Access service token)

## Notes / future
- `MemoryVault.alarm()` retries queued index jobs and runs the daily history cleanup.
- Search indexing is durable. Every change to a memory queues it in `index_jobs` in the same step; the write then tries to index it right away, and the alarm retries failures with backoff (1 min doubling to 1 h). Each memory keeps its embedding in SQLite with `embedded_hash`, the content hash it was made from, so a stale or out-of-order embedding is never used as current. Status changes reuse the stored embedding. "Rebuild search index" in the dashboard (`POST /api/reindex`, `?reembed=1` to recompute embeddings) re-sends every memory from SQLite.
- Vectorize ingests asynchronously (observed 1–3+ min before `vectorCount` moves). Rows updated in the last 30 min, or still queued for indexing, are scored from their stored embedding instead of Vectorize, so new writes are semantically recallable immediately and stale vectors are ignored. Semantic hits below cosine 0.6 (`MIN_SEMANTIC_SIM`) are dropped.
- type/status filtering is done in SQL, not by a Vectorize filter. Metadata indexes for `type` and `status` were created anyway for future use: `npx wrangler vectorize create-metadata-index frank-memory-index --propertyName=type --type=string` (and the same for `status`).
- Vectorize has a single index with no namespace, so it assumes one vault. For multiple vaults, add a Vectorize `namespace` per vault name.
- Secret detection is regex-based (`src/helpers.ts`), so it is a safety net, not a guarantee.

## License
[MIT](LICENSE)
