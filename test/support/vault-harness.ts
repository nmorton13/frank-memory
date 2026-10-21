// Runs MemoryVault in Node: SQLite via node:sqlite, with Workers AI and Vectorize mocked.
// The SQL wrapper enforces the Durable Object limits the vault has to live within
// (https://developers.cloudflare.com/durable-objects/platform/limits/).
import { DatabaseSync } from "node:sqlite";
import { MemoryVault } from "../../src/vault";
import { MERGE_MODEL } from "../../src/helpers";

const MAX_BOUND_PARAMS = 100;
const MAX_LIKE_PATTERN_BYTES = 50;
const DIMS = 768;

function toNode(v: unknown) {
  return v instanceof ArrayBuffer ? new Uint8Array(v) : v;
}
function fromNode(row: Record<string, unknown>) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Uint8Array) row[k] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  }
  return row;
}

class SqlStorage {
  constructor(readonly db: DatabaseSync) {}
  exec(query: string, ...bindings: unknown[]) {
    if (bindings.length > MAX_BOUND_PARAMS) throw new Error(`too many SQL variables (${bindings.length} > ${MAX_BOUND_PARAMS})`);
    if (/\bLIKE\b/i.test(query)) {
      for (const b of bindings)
        if (typeof b === "string" && new TextEncoder().encode(b).length > MAX_LIKE_PATTERN_BYTES) throw new Error("LIKE or GLOB pattern too complex");
    }
    let rows: Record<string, unknown>[] = [];
    if (!bindings.length && /;\s*\S/.test(query)) this.db.exec(query);
    else rows = (this.db.prepare(query).all(...(bindings.map(toNode) as any[])) as Record<string, unknown>[]).map(fromNode);
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
        return rows[0];
      },
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  }
}

/** Deterministic pseudo-random unit-ish vector for a text (unrelated texts are ~orthogonal). */
function hashVector(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  const out: number[] = [];
  for (let i = 0; i < DIMS; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) ^ i;
    out.push(((h >>> 0) / 0xffffffff) * 2 - 1);
  }
  return out;
}
function cos(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
/** A vector with the given cosine similarity to `base`. */
export function vectorNear(base: number[], sim: number, salt = "x"): number[] {
  const n = hashVector(salt);
  const nb = Math.sqrt(base.reduce((s, x) => s + x * x, 0));
  const u = base.map((x) => x / nb);
  const dot = n.reduce((s, x, i) => s + x * u[i], 0);
  const perp = n.map((x, i) => x - dot * u[i]);
  const np = Math.sqrt(perp.reduce((s, x) => s + x * x, 0));
  return u.map((x, i) => sim * x + Math.sqrt(1 - sim * sim) * (perp[i] / np));
}

export function createVault(opts: { approvalMode?: "review" | "auto"; db?: DatabaseSync } = {}) {
  const db = opts.db ?? new DatabaseSync(":memory:");
  const sql = new SqlStorage(db);
  const vectorsById = new Map<string, number[]>();
  const overrides = new Map<string, number[]>();
  let pause: { gate: Promise<void>; reached: () => void } | null = null;
  /** Outage switches and call counts, for tests. */
  const state = {
    aiDown: false, vectorizeDown: false, aiHang: false, vectorizeHang: false, aiCalls: 0, alarmAt: null as number | null,
    /** Answers of the chat model (area labeling and descriptions), by prompt; counted separately from aiCalls. */
    chat: (prompt: string): string => (prompt.startsWith("These memories") ? "Work on this area" : "[]"),
    /** Answers to the yes/no checks before a memory is put into an existing area. */
    confirm: (_prompt: string): string => "Yes.",
    /** Answers of the merge model (same fact? / merged text / final check), by prompt. Never merges by default. */
    merge: (_prompt: string): string => "No.",
    chatDown: false, chatCalls: 0, prompts: [] as string[],
  };

  const AI = {
    async run(model: string, input: { text?: string[]; messages?: { content: string }[] }) {
      if (input.messages && model === MERGE_MODEL) {
        state.chatCalls++;
        if (state.chatDown) throw new Error("AI unavailable");
        const prompt = input.messages[input.messages.length - 1].content;
        state.prompts.push(prompt);
        return { response: state.merge(prompt) };
      }
      if (input.messages) {
        state.chatCalls++;
        if (state.chatDown) throw new Error("AI unavailable");
        const prompt = input.messages[input.messages.length - 1].content;
        state.prompts.push(prompt);
        return { response: prompt.startsWith("A personal memory vault") ? state.confirm(prompt) : state.chat(prompt) };
      }
      state.aiCalls++;
      if (state.aiDown) throw new Error("AI unavailable");
      if (state.aiHang) return new Promise<never>(() => {});
      if (pause) { const p = pause; pause = null; p.reached(); await p.gate; }
      return { data: input.text!.map((t) => overrides.get(t) ?? hashVector(t)) };
    },
  };
  const VECTORIZE = {
    async upsert(vs: { id: string; values: number[] }[]) {
      if (state.vectorizeDown) throw new Error("Vectorize unavailable");
      for (const v of vs) vectorsById.set(v.id, v.values);
      return { mutationId: "m" };
    },
    async deleteByIds(ids: string[]) {
      if (state.vectorizeDown) throw new Error("Vectorize unavailable");
      for (const id of ids) vectorsById.delete(id);
      return { mutationId: "m" };
    },
    async query(v: number[], o: { topK?: number }) {
      if (state.vectorizeDown) throw new Error("Vectorize unavailable");
      if (state.vectorizeHang) return new Promise<never>(() => {});
      const topK = o.topK ?? 5;
      if (topK > 100) throw new Error("topK must be <= 100");
      const matches = [...vectorsById].map(([id, values]) => ({ id, score: cos(v, values) }))
        .sort((a, b) => b.score - a.score).slice(0, topK);
      return { matches, count: matches.length };
    },
  };
  const ctx = {
    storage: {
      sql, getAlarm: async () => state.alarmAt, setAlarm: async (t: number) => { state.alarmAt = t; },
      transactionSync<T>(fn: () => T): T {
        db.exec("BEGIN");
        try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
      },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  };
  const vault = new MemoryVault(ctx as any, { AI, VECTORIZE, OWNER_NAME: "Sam" } as any);
  if (opts.approvalMode) db.prepare(`UPDATE settings SET value = ? WHERE key = 'approval_mode'`).run(opts.approvalMode);

  return {
    vault,
    state,
    /** Make every queued index job due now (instead of waiting out its backoff). */
    makeJobsDue() { db.prepare(`UPDATE index_jobs SET next_at = ?`).run(new Date(0).toISOString()); },
    jobs() { return db.prepare(`SELECT memory_id, attempts, last_error FROM index_jobs`).all() as any[]; },
    areaJobs() { return db.prepare(`SELECT memory_id, attempts, last_error FROM area_jobs`).all() as any[]; },
    mergeJobs() { return db.prepare(`SELECT memory_id, attempts, last_error FROM merge_jobs`).all() as any[]; },
    /** Make every queued area job due now. */
    makeAreaJobsDue() { db.prepare(`UPDATE area_jobs SET next_at = ?`).run(new Date(0).toISOString()); },
    db,
    vectors: vectorsById,
    /** Pin the embedding returned for an exact text. */
    embedAs(text: string, vec: number[]) { overrides.set(text, vec); },
    embeddingOf(text: string) { return overrides.get(text) ?? hashVector(text); },
    /** Hold the next Workers AI call: `reached` resolves once it is waiting, release() lets it finish. */
    pauseNextEmbed() {
      let release!: () => void, reached!: () => void;
      const reachedP = new Promise<void>((r) => (reached = r));
      pause = { gate: new Promise<void>((r) => (release = r)), reached };
      return { reached: reachedP, release: () => release() };
    },
    rows(where = "1=1", ...args: any[]) {
      return db.prepare(`SELECT id, content, status, supersedes, similar_to, batch_id, updated_at, area FROM memories WHERE ${where}`).all(...args) as any[];
    },
  };
}
