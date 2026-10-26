// Pure helpers (no Cloudflare bindings) so they can be unit-tested in Node.

// No "task" type: to-dos and open loops belong in the agent's own tools or a work log, not durable memory.
export const MEMORY_TYPES = ["fact", "preference", "decision", "note", "project"] as const;
export const MEMORY_STATUSES = ["active", "proposed", "superseded", "rejected"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface ImportItem {
  content: string;
  type?: MemoryType;
  source?: string;
  source_date?: string;
}

/** Normalize text for hashing/dedupe: trim, collapse whitespace, lowercase. */
export function normalizeForHash(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const contentHash = (s: string) => sha256Hex(normalizeForHash(s));

const BULLET_RE = /^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

/**
 * Split raw text/markdown into candidate memory items.
 * - JSON array of strings or {content,type?} objects is accepted.
 * - If the text contains `---` separator lines, split on those.
 * - Otherwise split on blank-line paragraphs; a paragraph made only of bullet
 *   lines becomes one item per bullet. Standalone markdown headings are dropped.
 */
export function splitImportText(raw: string): ImportItem[] {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return coerceItems(parsed);
    } catch {
      /* fall through to text handling */
    }
  }
  const blocks = /^\s*---+\s*$/m.test(text) ? text.split(/^\s*---+\s*$/m) : text.split(/\n\s*\n/);
  const out: ImportItem[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/^\s*#{1,6}\s/.test(l)); // drop headings
    if (!lines.length) continue;
    const bullets = lines.filter((l) => BULLET_RE.test(l));
    if (bullets.length === lines.length) {
      for (const l of lines) {
        const c = l.replace(BULLET_RE, "").trim();
        if (c) out.push({ content: c });
      }
    } else {
      const c = lines.map((l) => l.trim()).join(" ").trim();
      if (c) out.push({ content: c });
    }
  }
  return out;
}

export function coerceItems(arr: unknown[]): ImportItem[] {
  const out: ImportItem[] = [];
  for (const x of arr) {
    if (typeof x === "string") {
      if (x.trim()) out.push({ content: x.trim() });
    } else if (x && typeof x === "object" && typeof (x as any).content === "string") {
      const o = x as any;
      if (!o.content.trim()) continue;
      out.push({
        content: o.content.trim(),
        type: isMemoryType(o.type) ? o.type : undefined,
        source: typeof o.source === "string" ? o.source : undefined,
        source_date: typeof o.source_date === "string" ? o.source_date : undefined,
      });
    }
  }
  return out;
}

export const isMemoryType = (t: unknown): t is MemoryType =>
  typeof t === "string" && (MEMORY_TYPES as readonly string[]).includes(t);
export const isMemoryStatus = (t: unknown): t is MemoryStatus =>
  typeof t === "string" && (MEMORY_STATUSES as readonly string[]).includes(t);

/** Words too common to carry meaning in a keyword search ("what URL is it served at"). */
const STOPWORDS = new Set((
  "a an and any are as at be been but by can could did do does for from had has have how i if in into is it its " +
  "me my of on or our should so than that the their them then there these they this those to was we were what " +
  "when where which who whom why will with would you your about tell know"
).split(" "));

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: quoted terms joined with OR,
 * stopwords dropped (unless nothing else is left). Returns null when there is nothing searchable.
 */
export function sanitizeFtsQuery(q: string, maxTerms = 16): string | null {
  const terms = (q.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (t) => t.length >= 2 || /\p{N}/u.test(t),
  );
  const content = terms.filter((t) => !STOPWORDS.has(t));
  const uniq = [...new Set(content.length ? content : terms)].slice(0, maxTerms);
  if (!uniq.length) return null;
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** Semantic hits below this cosine are dropped (bge-base-en-v1.5: unrelated short memories score 0.42-0.64). */
export const MIN_SEMANTIC_SIM = 0.6;
/** Similarity at which the semantic part of the score saturates. */
const FULL_SEMANTIC_SIM = 1.0;
export const SEMANTIC_WEIGHT = 0.75;
export const KEYWORD_WEIGHT = 0.25;
/** Tie-breakers only: much smaller than the gap between a strong and a weak match. */
const ACTIVE_BONUS = 0.02, RECENCY_BONUS = 0.01, OTHER_STATUS_PENALTY = 0.05;

/** Score bonus for a hit in the question's area: reorders close matches, can't lift a weak match over a strong one. */
export const AREA_BONUS = 0.1;
/** Order memory types are grouped in when whole areas are returned (and in the Markdown export). */
export const TYPE_ORDER = ["fact", "preference", "decision", "project", "note"];

// ---------- areas ----------
/**
 * Agent recall returns the question's whole area while it has at most AREA_ALL_MAX_MEMORIES and fits
 * AREA_ALL_BUDGET_TOKENS of slim records (about 4 chars each). Over that, it returns the area's preferences
 * and relies on hybrid search for the rest.
 */
export const AREA_ALL_MAX_MEMORIES = 20;
export const AREA_ALL_BUDGET_TOKENS = 1_500;
/**
 * General memories (about the owner, how to work with them) matter for every question.
 * Over this budget (or > AREA_ALL_MAX_MEMORIES), recall returns the general preferences in full and finds other general memories by search.
 */
export const GENERAL_ALL_BUDGET_TOKENS = 2_000;
/**
 * The general preferences (how to work with the owner) have their own, larger limits, because an agent needs them
 * for every question and rarely searches for them. Over these, none load and search finds them.
 */
export const GENERAL_PREFS_MAX_MEMORIES = 40;
export const GENERAL_PREFS_BUDGET_TOKENS = 4_000;
/** An area is created once this many memories point to the same name. */
export const AREA_MIN_MEMORIES = 3;

export type AreaSource = "agent" | "inherited" | "source";
export interface AreaDef { name: string; aliases: string[] }

/** Canonical area name: lowercase words joined by "-", without a domain suffix ("LFKai.town" -> "lfkai"). Null for none. */
export function normalizeArea(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const n = s.toLowerCase().trim()
    .replace(/\.(com|net|org|io|ai|app|dev|town|co|xyz)$/, "")
    .replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return n && n.length <= 40 && !GENERIC_AREA_NAMES.has(n) ? n : null;
}
/** Words that name no particular area; a model or agent suggesting one is treated as "general". */
const GENERIC_AREA_NAMES = new Set(["general", "none", "unknown", "other", "misc", "personal", "life", "work", "home", "project",
  "the-project", "projects", "technology", "tech", "software", "code", "ai", "notes", "memory", "preferences"]);

/** The repo named in a source such as "cursor: repo frank-memory (via Cursor)", normalized. */
export function repoFromSource(source: string | null | undefined): string | null {
  return normalizeArea(source?.match(/\brepo[:\s]+([\w.-]+)/i)?.[1]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A source with each run of the same " (via App)" suffix cut to one: "x (via Cursor) (via Cursor)" -> "x (via Cursor)". */
export function collapseVia(source: string): string {
  return source.replace(/( \(via ([^()]+)\))(?: \(via \2\))+/g, "$1");
}

/**
 * A source tagged with the app that wrote it, once. Agents often pass back the source of a memory they recalled,
 * suffix included, which used to store "(via Claude Code) (via Claude Code)".
 */
export function withClient(source: string | undefined, client: string | undefined): string | undefined {
  if (!client) return source;
  if (!source) return `via ${client}`;
  const s = collapseVia(source.trim());
  return s === `via ${client}` || s.endsWith(`(via ${client})`) ? s : `${s} (via ${client})`;
}

/** Areas whose name or an alias appears in the text as a whole word; "frank-memory" also matches "frank memory". */
export function areasNamedIn(text: string, areas: AreaDef[]): string[] {
  const found: string[] = [];
  for (const a of areas) {
    const terms = [a.name, ...a.aliases].filter((t) => t.length >= 3);
    if (terms.some((t) => new RegExp(`(?<![a-z0-9])${t.split("-").map(escapeRe).join("[-\\s]?")}(?![a-z0-9])`, "i").test(text)))
      found.push(a.name);
  }
  return found;
}

/** The area a normalized name or alias refers to. */
export function resolveArea(name: string, areas: AreaDef[]): string | null {
  return areas.find((a) => a.name === name || a.aliases.includes(name))?.name ?? null;
}

/**
 * Which area a memory belongs to, by rule: the agent's choice, else the area of the memory it replaces, else the
 * repo in its source. Anything else stays general (area null) for the model to label; `hint` is a name that isn't
 * an area yet, counted toward creating one. Preferences are only labeled by an agent or by inheritance: a general
 * preference pinned to one project would rank lower everywhere else. An area named in the text is not a rule: on the
 * live vault it put "lives in Lawrence" into LFKai, so naming goes through the model and its yes/no check instead.
 */
export function pickArea(
  m: { content: string; type: string; source?: string | null },
  opts: { explicit?: string | null; inherited?: string | null },
  areas: AreaDef[],
): { area: string | null; source: AreaSource | null; hint: string | null } {
  const resolve = (n: string) => resolveArea(n, areas);
  const explicit = normalizeArea(opts.explicit);
  if (explicit) return { area: resolve(explicit), source: "agent", hint: resolve(explicit) ? null : explicit };
  if (opts.inherited) return { area: opts.inherited, source: "inherited", hint: null };
  const repo = repoFromSource(m.source);
  const fromRepo = repo ? resolve(repo) : null;
  // Its repo still counts toward creating that area.
  if (m.type === "preference") return { area: null, source: null, hint: fromRepo ? null : repo };
  if (fromRepo) return { area: fromRepo, source: "source", hint: null };
  return { area: null, source: null, hint: repo };
}

export interface RecallSignals {
  /** Cosine similarity, when the memory was a semantic hit (>= MIN_SEMANTIC_SIM). */
  similarity?: number;
  /** Keyword strength in (0, 1]: this hit's bm25 relative to the best keyword hit; undefined if no keyword match. */
  keyword?: number;
  status: string;
  updatedAtMs: number;
  /** The memory is in the area the question is about. */
  inArea?: boolean;
}

/**
 * Relevance score for a recall hit. Driven by how similar the memory actually is (not its rank),
 * plus keyword strength; status and recency only break near-ties, so a strongly matching
 * proposed memory outranks a weakly matching active one.
 */
export function scoreRecallHit(h: RecallSignals, nowMs = Date.now()): number {
  const sem = h.similarity === undefined ? 0
    : Math.min(Math.max((h.similarity - MIN_SEMANTIC_SIM) / (FULL_SEMANTIC_SIM - MIN_SEMANTIC_SIM), 0), 1);
  const kw = Math.min(Math.max(h.keyword ?? 0, 0), 1);
  const ageDays = Math.max(0, (nowMs - h.updatedAtMs) / 86_400_000);
  const status = h.status === "active" ? ACTIVE_BONUS : h.status === "proposed" ? 0 : -OTHER_STATUS_PENALTY;
  return SEMANTIC_WEIGHT * sem + KEYWORD_WEIGHT * kw + status + RECENCY_BONUS * Math.exp(-ageDays / 180) + (h.inArea ? AREA_BONUS : 0);
}

/** bm25 values (lower = better, typically negative) -> strength in (0, 1] relative to the best one. */
export function keywordStrengths(rows: { id: string; bm25: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!rows.length) return out;
  const best = Math.min(...rows.map((r) => r.bm25));
  for (const r of rows) out.set(r.id, best < 0 && r.bm25 < 0 ? r.bm25 / best : 1 / (1 + rows.indexOf(r)));
  return out;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-|live_|test_)?[A-Za-z0-9_-]{16,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:password|passwd|pwd|passcode|pin)\s*(?:is|[:=])\s*\S{4,}/i,
  /\b(?:api[_ -]?key|secret|access[_ -]?token|auth[_ -]?token|token|client[_ -]?secret)\s*(?:is|[:=])\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i, // credentials in URL
];

/** Heuristic: does this text look like it contains a credential/secret? */
export function looksLikeSecret(s: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(s));
}

/**
 * Limits on memory content and metadata. Content stays within what the embedding model reads (512 tokens, about
 * 2,000 chars), so all of it is searchable by meaning. `source` leaves room for the " (via <client>)" suffix MCP adds.
 */
export const MAX_CONTENT_LEN = 2000;
export const MAX_SOURCE_LEN = 300;
export const MAX_SOURCE_DATE_LEN = 40;
export const MAX_GUIDE_LEN = 50_000;

/** Checks the metadata stored next to a memory's content: too long, or looks like a secret. */
export function metadataProblem(m: { source?: string | null; source_date?: string | null }): { kind: "invalid" | "secret"; error: string } | null {
  if (m.source && m.source.length > MAX_SOURCE_LEN) return { kind: "invalid", error: `source too long (max ${MAX_SOURCE_LEN} chars)` };
  if (m.source_date && m.source_date.length > MAX_SOURCE_DATE_LEN) return { kind: "invalid", error: `source_date too long (max ${MAX_SOURCE_DATE_LEN} chars)` };
  if ((m.source && looksLikeSecret(m.source)) || (m.source_date && looksLikeSecret(m.source_date)))
    return { kind: "secret", error: "source or source_date looks like a secret/credential; nothing was stored." };
  return null;
}

/** Import limits, the same for MCP `bulk_remember` and `POST /api/bulk`. */
export const MAX_IMPORT_ITEMS = 1000;
export const MAX_IMPORT_TEXT = 400_000;

/** Time limits for Workers AI and Vectorize calls, so a slow service fails fast instead of hanging a request. */
export const AI_TIMEOUT_MS = 15_000;
export const VECTORIZE_TIMEOUT_MS = 10_000;

/** Rejects if `p` hasn't settled within `ms` (the call itself keeps running; its result is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Cosine similarity of two equal-length vectors (0 when either is zero/mismatched). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------- near-duplicate detection (bulk import) ----------

/**
 * Cosine thresholds for memory-vs-memory similarity with bge-base-en-v1.5, calibrated 2026-10-13 against the
 * live vault: rewordings scored 0.904-0.946, contradictions/updates ("1 Gbps" vs "2 Gbps", wired vs wireless)
 * 0.848-0.886, related-but-different facts 0.808-0.840, unrelated 0.61.
 * Skipping a real update is worse than reviewing a duplicate, so the skip bar sits above every contradiction seen.
 */
export const NEAR_DUP_SIM = 0.93;
export const SIMILAR_SIM = 0.8;

const NEGATION_RE = /\b(?:not|no|never|none|nor|without|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|no longer|stopped|disabled|removed|declined)\b/gi;

/** Tokens that change meaning without moving the embedding much: numbers, versions, IPs, dates, negations. */
export function meaningTokens(s: string): string {
  const t = s.normalize("NFKC").toLowerCase();
  const nums = t.match(/[\p{L}\p{N}._:/-]*\p{N}[\p{L}\p{N}._:/-]*/gu) ?? [];
  const negs = t.match(NEGATION_RE) ?? [];
  return [...new Set([...nums.map((n) => n.replace(/[.:/-]+$/, "")), ...negs])].sort().join("|");
}

export type DupVerdict = "near_duplicate" | "similar" | "new";

/** near_duplicate only when the vectors are nearly identical AND no number/version/date/negation differs. */
export function classifySimilarity(sim: number, candidate: string, existing: string): DupVerdict {
  if (sim >= NEAR_DUP_SIM && meaningTokens(candidate) === meaningTokens(existing)) return "near_duplicate";
  return sim >= SIMILAR_SIM ? "similar" : "new";
}

/** Unit-normalize a vector (returns a new Float32Array; zero vectors stay zero). */
export function unitVector(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v as ArrayLike<number>);
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n);
  if (n) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

/** Best match of a unit vector among unit vectors (dot product = cosine). */
export function bestMatch<T extends { vec: Float32Array }>(q: Float32Array, pool: T[]): { item: T; sim: number } | null {
  let best: T | null = null, bestSim = -Infinity;
  for (const p of pool) {
    if (p.vec.length !== q.length) continue;
    let d = 0;
    for (let i = 0; i < q.length; i++) d += q[i] * p.vec[i];
    if (d > bestSim) { bestSim = d; best = p; }
  }
  return best ? { item: best, sim: bestSim } : null;
}

/** Is value (case-insensitive) in a comma-separated allow-list? Used for Access emails and service-token IDs. */
export function listIncludes(value: unknown, allowList: string | undefined): boolean {
  if (typeof value !== "string" || !value.trim() || !allowList) return false;
  const want = value.trim().toLowerCase();
  return allowList.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(want);
}

/** Clamp a numeric query parameter; NaN or missing falls back to the default. */
export function intParam(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
}

// ---------- owner name (OWNER_NAME setting) ----------

/**
 * Fill owner placeholders in user-facing text: {owner}, {Owner}, {owner's}, {Owner's}.
 * With no name configured the text reads "the vault owner"; wording elsewhere avoids gendered pronouns.
 */
export function fillOwner(text: string, ownerName?: string): string {
  const name = ownerName?.trim();
  const lower = name || "the vault owner", upper = name || "The vault owner";
  return text
    .replace(/\{owner's\}/g, `${lower}'s`).replace(/\{Owner's\}/g, `${upper}'s`)
    .replace(/\{owner\}/g, lower).replace(/\{Owner\}/g, upper);
}

/**
 * Compact memory record for MCP tool results, to keep agent context small.
 * Drops bookkeeping (content_hash, batch_id, embedding scores, created_at, nulls) and shortens dates.
 * The dashboard API still returns full records.
 */
export function slimMemory(m: {
  id: string; content: string; type: string; status: string; source?: string | null; source_date?: string | null;
  confirmed_at?: string | null; updated_at?: string; supersedes?: string | null; similar_to?: string | null; batch_id?: string | null;
  similar_status?: string | null; score?: number; area?: string | null;
}): Record<string, unknown> {
  const day = (s?: string | null) => (s ? s.slice(0, 10) : undefined);
  const out: Record<string, unknown> = { id: m.id, type: m.type, status: m.status, content: m.content };
  if (m.area) out.area = m.area;
  if (m.source) out.source = m.source;
  if (m.source_date) out.source_date = m.source_date;
  if (m.confirmed_at) out.confirmed = day(m.confirmed_at);
  if (m.batch_id) out.imported = true;
  if (m.updated_at) out.updated = day(m.updated_at);
  if (m.supersedes) out.supersedes = m.supersedes;
  if (m.similar_to && m.status === "proposed") out.review_with = m.similar_to;
  // Auto mode stores possible conflicts as active; flag them while the other memory is still active too.
  if (m.similar_to && m.status === "active" && m.similar_status === "active") out.may_conflict_with = m.similar_to;
  if (typeof m.score === "number") out.score = Number(m.score.toFixed(3));
  return out;
}

/** How long history is kept before the daily cleanup removes it. 0 = keep forever. */
export const RETENTION_KEYS = ["superseded_days", "rejected_days", "audit_days"] as const;
export type RetentionKey = (typeof RETENTION_KEYS)[number];
export type Retention = Record<RetentionKey, number>;
export const RETENTION_DEFAULTS: Retention = { superseded_days: 365, rejected_days: 30, audit_days: 365 };
export const MAX_RETENTION_DAYS = 3650;

/** ISO cutoff for a retention period, or null when the period is 0 (keep forever) or invalid. */
export function retentionCutoff(days: number, nowMs = Date.now()): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** Parse a retention value from user input: whole days, 0..MAX_RETENTION_DAYS, else null. */
export function parseRetentionDays(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_RETENTION_DAYS ? n : null;
}

// ---------- full backup format ----------
export const BACKUP_FORMAT = "frank-memory-backup";
export const BACKUP_VERSION = 1;
/** Types the memories table accepts, including legacy "task" rows. */
const STORED_TYPES = [...MEMORY_TYPES, "task"];

export interface BackupMemory {
  id: string; content: string; type: string; status: string; supersedes: string | null; source: string | null;
  content_hash: string; batch_id: string | null; source_date: string | null; confirmed_at: string | null;
  created_at: string; updated_at: string; similar_to: string | null;
  /** content_hash the embedding was made from, and the embedding as base64 Float32 (null when omitted). */
  embedded_hash: string | null; embedding: string | null;
  /** Area labels; missing in backups made before areas, which are then labeled again on restore. */
  area?: string | null; area_source?: string | null; area_hint?: string | null;
}
export interface BackupArea {
  name: string; aliases: string[]; description: string; created_by: string; created_at: string;
  /** Embedding of the description as base64 Float32, or null. */
  embedding: string | null;
}
export interface Backup {
  format: typeof BACKUP_FORMAT; version: number; exported_at: string; embed_model: string;
  guide: { content: string; version: number; updated_at: string };
  guide_history: { version: number; content: string; updated_at: string; actor: string | null }[];
  settings: Record<string, string>;
  memories: BackupMemory[];
  exclusions: { id: string; pattern_hash: string; description: string | null; created_at: string }[];
  batches: { id: string; source: string | null; added: number; created_at: string; undone_at: string | null }[];
  audit: { action: string; memory_id: string | null; actor: string | null; details: string | null; timestamp: string }[];
  /** Missing in backups made before areas. */
  areas?: BackupArea[];
}

/** Validate an uploaded backup. Returns the backup, or an error naming the first problem found. */
export function parseBackup(x: unknown): { backup: Backup } | { error: string } {
  const o = x as any;
  if (!o || typeof o !== "object" || o.format !== BACKUP_FORMAT) return { error: "not a frank-memory backup (use a file from Download backup, not Export)" };
  if (o.version !== BACKUP_VERSION) return { error: `unsupported backup version ${o.version} (this vault reads version ${BACKUP_VERSION})` };
  const str = (v: unknown) => typeof v === "string";
  const opt = (v: unknown) => v === null || v === undefined || typeof v === "string";
  // Ids end up in dashboard markup, so only the characters newId produces get in.
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
  const optId = (v: unknown) => v === null || v === undefined || id(v);
  // Area names too: only the canonical form normalizeArea produces.
  const areaName = (v: unknown) => typeof v === "string" && normalizeArea(v) === v;
  const list = (name: string, ok: (r: any) => boolean): string | null => {
    if (!Array.isArray(o[name])) return `${name} must be a list`;
    const i = o[name].findIndex((r: any) => !r || typeof r !== "object" || !ok(r));
    return i === -1 ? null : `${name}[${i}] is malformed`;
  };
  const problem =
    list("memories", (m) => id(m.id) && str(m.content) && m.content.trim() && STORED_TYPES.includes(m.type) &&
      (MEMORY_STATUSES as readonly string[]).includes(m.status) && str(m.created_at) && str(m.updated_at) &&
      [m.source, m.content_hash, m.source_date, m.confirmed_at, m.embedded_hash, m.embedding,
        m.area, m.area_source, m.area_hint].every(opt) && [m.supersedes, m.batch_id, m.similar_to].every(optId)) ??
    (o.areas === undefined ? null : list("areas", (a) => areaName(a.name) && Array.isArray(a.aliases) && a.aliases.every(str) && str(a.description) &&
      str(a.created_by) && str(a.created_at) && opt(a.embedding))) ??
    list("exclusions", (e) => id(e.id) && str(e.pattern_hash) && str(e.created_at) && opt(e.description)) ??
    list("batches", (b) => id(b.id) && str(b.created_at) && Number.isInteger(b.added) && opt(b.source) && opt(b.undone_at)) ??
    list("guide_history", (g) => Number.isInteger(g.version) && str(g.content) && str(g.updated_at) && opt(g.actor)) ??
    list("audit", (a) => str(a.action) && str(a.timestamp) && opt(a.memory_id) && opt(a.actor) && opt(a.details));
  if (problem) return { error: problem };
  if (!o.guide || !str(o.guide.content) || !o.guide.content.trim() || !Number.isInteger(o.guide.version) || !str(o.guide.updated_at)) return { error: "guide is malformed" };
  if (!o.settings || typeof o.settings !== "object" || !Object.values(o.settings).every(str)) return { error: "settings must map names to strings" };
  if (o.settings.blocked_areas !== undefined) {
    let blocked: unknown; try { blocked = JSON.parse(o.settings.blocked_areas); } catch { blocked = null; }
    if (!Array.isArray(blocked) || !blocked.every(areaName)) return { error: "settings.blocked_areas is malformed" };
  }
  const ids = new Set<string>();
  for (const m of o.memories) { if (ids.has(m.id)) return { error: `duplicate memory id ${m.id}` }; ids.add(m.id); }
  return { backup: o as Backup };
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToBuffer(s: string): ArrayBuffer {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ---------- areas: background labeling ----------
/** Small Workers AI model that labels memories the rules can't place and describes new areas. */
export const AREA_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
/**
 * The area a question is about, judged by its best search matches: the top match's area, if at least 3 of the top 5
 * share it. On a real vault (2026-10-20) comparing questions with area descriptions instead scored right and wrong
 * areas alike (0.63-0.64), while the matches themselves name the area reliably.
 */
export function dominantArea(hits: { area?: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const h of hits.slice(0, 5)) if (h.area) counts.set(h.area, (counts.get(h.area) ?? 0) + 1);
  for (const [area, n] of counts) if (n >= 3) return area;
  return null;
}
/** A new name the model suggests becomes an alias of an area whose description it is this similar to. */
export const AREA_ALIAS_SIM = 0.85;

/** The area `vec` clearly belongs to: at least `min` similar to its description and `margin` ahead of the next. */
export function closestArea(vec: ArrayLike<number>, areas: { name: string; vec: ArrayLike<number> }[], min: number, margin: number): string | null {
  const sims = areas.map((a) => ({ name: a.name, sim: cosine(vec, a.vec) })).sort((a, b) => b.sim - a.sim);
  if (!sims.length || sims[0].sim < min) return null;
  return sims.length === 1 || sims[0].sim - sims[1].sim >= margin ? sims[0].name : null;
}

/** An area whose whole name appears in a suggested name ("lfkai-workshop" -> "lfkai"), so it is an alias, not a new area. */
export function aliasOf(name: string, areas: AreaDef[]): string | null {
  return areas.find((a) => `-${name}-`.includes(`-${a.name}-`))?.name ?? null;
}

export function areaLabelPrompt(m: { content: string; type: string }, areas: { name: string; description: string }[]): string {
  const known = areas.length ? areas.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`).join("\n") : "(none yet)";
  return `You sort the memories in a personal memory vault into areas. An area is one project or product (such as a named app, website or code repo) or one part of the owner's life (such as "career", "running", "family", "health", "home network").

Known areas:
${known}

Memory (type: ${m.type}):
"""
${m.content}
"""

Which area is this memory about? Answer with only a JSON array:
- [] if the memory is about the owner in general: who they are, their tools, how they like to work or write, or tastes that apply everywhere; or if you are unsure;
- ["<known area name>"] if it is about one of the known areas;
- ["<new area name>"] only if it is clearly about one specific project, product or part of life that is not listed. For a project use its own name; for a part of life use a short common name like "career" (jobs, work history, resumes, job search), "running", "family" or "health". Never use a vague word like "project", "work", "personal" or "technology".
A memory that only mentions a project or place in passing is not about it: living in a city is not about a website named after it, and building one tool is not about another.`;
}

/**
 * Second check before the model's answer puts a memory into an existing area. On a real vault it caught every wrong
 * placement (a home town into the website named after it, one podcast tool into another), at the cost of leaving a
 * few right ones general.
 */
export function areaConfirmPrompt(content: string, area: { name: string; description: string }): string {
  return `A personal memory vault sorts memories into areas.

Area "${area.name}": ${area.description || "(no description yet)"}

Memory:
"""
${content}
"""

Is this memory about the area "${area.name}" itself? Answer "yes" or "no" and nothing else. Answer "no" if it only mentions "${area.name}" in passing, or is about the owner, another project, or something with a similar name.`;
}

/** Second check before a preference is tied to one area: a preference pinned wrongly ranks lower everywhere else. */
export function areaPreferencePrompt(content: string, area: { name: string; description: string }): string {
  return `A personal memory vault keeps the owner's preferences. Some apply only to one area of their life; others apply everywhere.

Area "${area.name}": ${area.description || "(no description yet)"}

Preference:
"""
${content}
"""

Does this preference only matter when working on "${area.name}"? Answer "yes" or "no" and nothing else. Answer "no" if it is about the owner in general (their name, taste or way of working) or would also apply elsewhere, even if it mentions "${area.name}".`;
}

export function areaDescriptionPrompt(name: string, samples: string[]): string {
  return `These memories from a personal memory vault belong to the area "${name}":
${samples.map((s) => `- ${s.slice(0, 300)}`).join("\n")}

Write one short line (under 15 words) listing the topics the area "${name}" covers, for example "Garden: vegetable beds, watering schedule, pests". Don't mention the owner or any person by name. Reply with the line only.`;
}

/**
 * Area names from a model answer: a JSON array such as `["lfkai"]`, or a bare name (some models drop the brackets);
 * "none" or "general" mean []. Null for an empty answer or anything else, so the job retries.
 */
export function parseAreaNames(text: string): string[] | null {
  const arrays = text.match(/\[[^\]]*\]/g);
  if (arrays) {
    try {
      const v = JSON.parse(arrays[arrays.length - 1]);
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? v.slice(0, 3) : null;
    } catch { return null; }
  }
  const bare = text.trim().replace(/["'`.]/g, "");
  if (!bare) return null;
  if (/^(none|general)$/i.test(bare)) return [];
  return bare.length <= 40 && !bare.includes("\n") ? [bare] : null;
}

/**
 * The text of a Workers AI chat answer. Some models answer in OpenAI form (`choices`), and Workers AI parses a JSON
 * answer into `response` (`["lfkai"]` arrives as an array), so this prefers the raw message text.
 */
export function chatText(r: unknown): string {
  const o = r as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const content = o?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (typeof o?.response === "string") return o.response.trim();
  return o?.response === undefined || o?.response === null ? "" : JSON.stringify(o.response);
}

// ---------- merging repeats ----------
/**
 * Model that decides whether two memories repeat the same fact and writes the merged memory. Larger than AREA_MODEL
 * because it is asked rarely (only for close pairs) and a wrong merge costs more: on a real vault (2026-10-21)
 * Mistral Small also glued separate facts together, and Llama 3.3 70B made no wrong merges.
 */
export const MERGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Pairs at least this similar are checked. On a real vault the repeats scored 0.70-0.96 and look-alikes down to 0.63. */
export const MERGE_MIN_SIM = 0.68;

export function sameFactPrompt(type: string, a: string, b: string): string {
  return `A personal memory vault sometimes stores the same fact twice in different words, for example because two AI assistants each saved it. Decide whether these two memories (both of type ${type}) are such a repeat.

A: """${a}"""
B: """${b}"""

Answer Yes only if A and B are about the same single thing and repeat at least part of what they say about it: the same fact told twice, or one a fuller version of the other.
Answer No if:
- each covers a different part of the subject, so both could stand alone (two devices, a job and separate work done in that job, a router's model and its DNS setting, a project and its code's status);
- they are two separate rules or preferences, even on a related topic;
- they are two decisions or choices, even about the same system, unless one plainly restates the other;
- one gives a reason, date or detail the other lacks and would lose if only the other were kept;
- they disagree about anything (a date, number, name, amount or choice);
- you are unsure.
Answer Yes or No.`;
}

export function mergePrompt(a: string, b: string): string {
  return `These two memories from a personal memory vault say the same thing in different words:

A: """${a}"""
B: """${b}"""

Write one memory that replaces both: standalone, in the same style, keeping every detail from either one and adding nothing. Answer with only the memory.`;
}

/**
 * Last check before two memories are replaced by one (the merged text, or the fuller of the two). It asks for what is
 * missing rather than for a yes: on a real vault a yes/no check passed merges that dropped "public" from a writing
 * rule and "policy chatbot" from a job.
 */
export function mergeCheckPrompt(a: string, b: string, replacement: string): string {
  return `A personal memory vault wants to replace two memories with one.

A: """${a}"""
B: """${b}"""
Replacement: """${replacement}"""

Compare them word by word. Briefly list every fact, reason, name, number, limit, exception or scope word (such as "public", "only", "never", "all") from A or B that is missing or changed in the replacement, and anything it adds that is in neither. A different wording for the same meaning is fine.
End with a last line that is exactly NOTHING MISSING or SOMETHING MISSING.`;
}

/** True when the final merge check ended with its NOTHING MISSING verdict. */
export function isNothingMissing(answer: string): boolean {
  const last = answer.trim().split("\n").pop() ?? "";
  return /^\W*nothing missing\W*$/i.test(last);
}

export function isYes(answer: string): boolean {
  return /^\W*yes\b/i.test(answer);
}

/** A written merge without wrapping quotes. */
export function cleanMerged(text: string): string {
  return text.trim().replace(/^("""|"|“)/, "").replace(/("""|"|”)$/, "").trim();
}

/** Words that set a rule's scope or turn it around; a merge must keep each one either memory has. */
const SCOPE_WORDS = ["public", "private", "only", "never", "always", "all", "every", "no", "not", "none", "except", "unless", "without", "must", "hard"];

/**
 * URLs, numbers, capitalized words (names) and scope words of `from` that `into` lacks. A merge that loses one is
 * refused: on a real vault the model dropped an essay's URL and two dates and still judged its merge complete, and
 * once folded a "public writing voice" rule into a job-application one by dropping "public".
 */
export function lostDetails(from: string, into: string): string[] {
  const have = into.toLowerCase();
  const words = new Set(have.match(/[\p{L}\p{N}']+/gu) ?? []);
  const details = (from.match(/https?:\/\/\S+|\p{Lu}[\p{L}\p{N}.'’-]*|\d[\d.,:%$KkMm–-]*/gu) ?? [])
    .map((t) => t.toLowerCase().replace(/[.,;:)\]"'”]+$/, "").replace(/['’]s$/, ""))
    .filter((t) => t.length > 1);
  const scope = (from.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter((w) => SCOPE_WORDS.includes(w) && !words.has(w));
  return [...new Set([...details.filter((d) => !have.includes(d)), ...scope])];
}

// ---------- Clef: relevance and conflict judgments ----------
/**
 * Cloudflare's decision model: given data and typed questions, it returns probabilities instead of text. On the live
 * vault (2026-10-21, 105 memories) it judged a loose candidate set for recall and put the right memory first for 34 of
 * 34 questions (embedding-and-keyword scoring: 30), with no junk for questions the vault can't answer (scoring: 15
 * junk hits on 8 questions). Clef-flash was worse (32 of 34).
 */
export const CLEF_MODEL = "@cf/cloudflare/clef";
/** Recall candidates Clef judges: the closest memories by meaning (no cutoff) plus keyword hits, at most CLEF_MAX. */
export const CLEF_SEMANTIC_CANDIDATES = 30;
/** Clef takes at most 64 questions per request. */
export const CLEF_MAX = 60;
/** A memory is returned when Clef gives it at least this probability of helping; on the live vault no unrelated memory scored above 0.18. */
export const CLEF_MIN_RELEVANCE = 0.3;
/** Similar import items are flagged as possible conflicts when Clef gives a contradiction at least this probability (contradictions scored 0.97-0.98, others at most 0.03). */
export const CLEF_MIN_CONFLICT = 0.5;
/** Recall waits this long for Clef, then falls back to embedding-and-keyword scoring. */
export const CLEF_TIMEOUT_MS = 8_000;

export function relevanceQuestion(key: string): string {
  return `Does memory ${key} help answer the question?`;
}

export function conflictQuestion(key: string): string {
  return `Do memory_a and memory_b in pair ${key} contradict each other about any date, number, name, amount or choice?`;
}

// ---------- write-time quality check ----------
/**
 * Model that checks a memory an agent wants to save, and sends back a work log, temporary progress or wording that
 * only makes sense inside the chat, with the reason. It never rewrites: on the live vault (2026-10-26) its rewrites
 * made up dates ("Sunday" became "Sunday, 2026-10-11"), and the agent that wrote the memory knows the date and the
 * subject, so it fixes the wording itself.
 */
export const QUALITY_MODEL = MERGE_MODEL;
/** A write waits this long for the check, then stores the memory as written. */
export const QUALITY_TIMEOUT_MS = 8_000;

export function qualityPrompt(m: { content: string; type: string }, owner: string): string {
  return `An AI assistant wants to save this memory to ${owner}'s long-term memory vault. Every assistant ${owner} uses will read it later, in other chats, weeks from now, with none of this chat's context.

Memory (type: ${m.type}):
"""
${m.content}
"""

Answer "reject" if any of these is true:
1. It is mainly a log of work just done: what was changed, committed, deployed, tested or fixed, with commit hashes, version ids, file names or test counts. The code repository and its history already record that.
2. It is temporary progress or a to-do: "now running tests", "next step: deploy", "remember to email Y", "waiting for the build".
3. It is small talk, or about this chat itself rather than about ${owner}, their life, people, systems or projects.
4. A reader weeks from now couldn't tell what it is about: its subject is a pronoun ("He prefers…", "They decided…") or "the user", "this", "the project", "the app" with no name anywhere in it, or it uses a relative date such as "yesterday", "today", "last week" or "next Thursday" instead of a calendar date. (A recurring day such as "every Sunday" is fine.)

Otherwise answer "keep". Keep these even when they mention commits, versions or dates: where a project stands (what is live, what is unfinished, what was chosen), a decision and its reason, a test result that explains a decision, a setup or configuration fact, a preference or a correction. Words like "maybe" or "considering" are fine: they record that ${owner} is unsure. When unsure, keep.

Answer in exactly this form, with nothing before it:
VERDICT: keep or reject
REASON: one short sentence; for reject, say what to change so it is worth keeping`;
}

/**
 * A memory that opens with a pronoun and names nothing ("He prefers dark mode in every editor."). The model keeps
 * these, so they are caught before it is asked.
 */
export function namesNoOne(content: string): boolean {
  const m = content.match(/^\s*(he|she|they|it|this|that|these|those|we)\b/i);
  return !!m && !/\p{Lu}/u.test(content.slice(m.index! + m[0].length));
}

/** The check's verdict from its answer, or null when the answer is unusable (the memory is then stored as written). */
export function parseQuality(answer: string): { verdict: "keep" } | { verdict: "reject"; reason: string } | null {
  const verdict = answer.match(/^\W*VERDICT:\W*(keep|reject)\b/im)?.[1].toLowerCase();
  const reason = (answer.match(/^\W*REASON:[*\s]*(.+)$/im)?.[1] ?? "").trim().slice(0, 300);
  if (verdict === "keep") return { verdict: "keep" };
  return verdict === "reject" && reason ? { verdict: "reject", reason } : null;
}
