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

export interface RecallSignals {
  /** Cosine similarity, when the memory was a semantic hit (>= MIN_SEMANTIC_SIM). */
  similarity?: number;
  /** Keyword strength in (0, 1]: this hit's bm25 relative to the best keyword hit; undefined if no keyword match. */
  keyword?: number;
  status: string;
  updatedAtMs: number;
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
  return SEMANTIC_WEIGHT * sem + KEYWORD_WEIGHT * kw + status + RECENCY_BONUS * Math.exp(-ageDays / 180);
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

/** Limits on memory metadata. `source` leaves room for the " (via <client>)" suffix MCP adds. */
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
  similar_status?: string | null; score?: number;
}): Record<string, unknown> {
  const day = (s?: string | null) => (s ? s.slice(0, 10) : undefined);
  const out: Record<string, unknown> = { id: m.id, type: m.type, status: m.status, content: m.content };
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
}

/** Validate an uploaded backup. Returns the backup, or an error naming the first problem found. */
export function parseBackup(x: unknown): { backup: Backup } | { error: string } {
  const o = x as any;
  if (!o || typeof o !== "object" || o.format !== BACKUP_FORMAT) return { error: "not a frank-memory backup (use a file from Download backup, not Export)" };
  if (o.version !== BACKUP_VERSION) return { error: `unsupported backup version ${o.version} (this vault reads version ${BACKUP_VERSION})` };
  const str = (v: unknown) => typeof v === "string";
  const opt = (v: unknown) => v === null || v === undefined || typeof v === "string";
  const list = (name: string, ok: (r: any) => boolean): string | null => {
    if (!Array.isArray(o[name])) return `${name} must be a list`;
    const i = o[name].findIndex((r: any) => !r || typeof r !== "object" || !ok(r));
    return i === -1 ? null : `${name}[${i}] is malformed`;
  };
  const problem =
    list("memories", (m) => str(m.id) && m.id && str(m.content) && m.content.trim() && STORED_TYPES.includes(m.type) &&
      (MEMORY_STATUSES as readonly string[]).includes(m.status) && str(m.created_at) && str(m.updated_at) &&
      [m.supersedes, m.source, m.content_hash, m.batch_id, m.source_date, m.confirmed_at, m.similar_to, m.embedded_hash, m.embedding].every(opt)) ??
    list("exclusions", (e) => str(e.id) && str(e.pattern_hash) && str(e.created_at) && opt(e.description)) ??
    list("batches", (b) => str(b.id) && str(b.created_at) && Number.isInteger(b.added) && opt(b.source) && opt(b.undone_at)) ??
    list("guide_history", (g) => Number.isInteger(g.version) && str(g.content) && str(g.updated_at) && opt(g.actor)) ??
    list("audit", (a) => str(a.action) && str(a.timestamp) && opt(a.memory_id) && opt(a.actor) && opt(a.details));
  if (problem) return { error: problem };
  if (!o.guide || !str(o.guide.content) || !o.guide.content.trim() || !Number.isInteger(o.guide.version) || !str(o.guide.updated_at)) return { error: "guide is malformed" };
  if (!o.settings || typeof o.settings !== "object" || !Object.values(o.settings).every(str)) return { error: "settings must map names to strings" };
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
