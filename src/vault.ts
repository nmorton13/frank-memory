import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { defaultGuide } from "./guide";
import {
  Backup, BACKUP_FORMAT, BACKUP_VERSION, base64ToBuffer, bufferToBase64, parseBackup,
  AI_TIMEOUT_MS, bestMatch, chunk, classifySimilarity, cosine, coerceItems, contentHash, sha256Hex, ImportItem, isMemoryStatus, isMemoryType,
  keywordStrengths, looksLikeSecret, MAX_CONTENT_LEN, MAX_GUIDE_LEN, MAX_IMPORT_ITEMS, MAX_IMPORT_TEXT, MemoryStatus, metadataProblem, MemoryType, MIN_SEMANTIC_SIM, parseRetentionDays, Retention, RETENTION_DEFAULTS, RETENTION_KEYS,
  retentionCutoff, sanitizeFtsQuery, scoreRecallHit, slimMemory, splitImportText, TYPE_ORDER,
  AREA_ALIAS_SIM, AREA_ALL_BUDGET_TOKENS, AREA_ALL_MAX_MEMORIES, AREA_BONUS, AREA_MIN_MEMORIES, AREA_MODEL, AreaDef, areaDescriptionPrompt, areaLabelPrompt, areasNamedIn,
  aliasOf, areaConfirmPrompt, areaPreferencePrompt, chatText, GENERAL_ALL_BUDGET_TOKENS, closestArea, dominantArea, GENERAL_PREFS_BUDGET_TOKENS, GENERAL_PREFS_MAX_MEMORIES, normalizeArea, parseAreaNames, pickArea, resolveArea, unitVector, VECTORIZE_TIMEOUT_MS, withTimeout,
} from "./helpers";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_DIMS = 768;
/** Settings that describe this instance's schedule rather than the vault, so backups leave them out. */
const LOCAL_SETTINGS = ["next_cleanup_at"];

export interface Memory {
  id: string; content: string; type: MemoryType; status: MemoryStatus;
  supersedes: string | null; source: string | null; content_hash: string;
  batch_id: string | null; source_date: string | null; confirmed_at: string | null;
  created_at: string; updated_at: string;
  /** Set by bulk import when this item closely resembles an existing memory; the pair is reviewed together. */
  similar_to: string | null; similar_content: string | null; similar_status: string | null;
  /** The project or area the memory belongs to (null = general); see pickArea. */
  area: string | null; area_source: string | null; area_hint: string | null;
}
export interface RecallHit extends Memory { score: number; matched: ("semantic" | "keyword")[]; similarity?: number }
export interface ListFilters { type?: string; status?: string; batch_id?: string; q?: string; area?: string }

const COLS = "id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at, created_at, updated_at, similar_to, area, area_source, area_hint, " +
  "(SELECT s.content FROM memories s WHERE s.id = memories.similar_to) AS similar_content, " +
  "(SELECT s.status FROM memories s WHERE s.id = memories.similar_to) AS similar_status";
/** Vectorize ingestion is async (can take minutes); rows written within this window are also scored locally. */
const FRESH_WINDOW_MS = 30 * 60_000;
/** Most memories one forget-by-phrase call deletes. */
const FORGET_PAGE = 50;
/** Case-insensitive substring match. Not LIKE: Durable Object SQLite caps LIKE patterns at 50 bytes. */
const PHRASE_MATCH = "instr(lower(content), lower(?)) > 0";
const CLEANUP_EVERY_MS = 24 * 60 * 60_000;
/** Most queued index jobs one sync pass handles; the alarm picks up the rest. */
const INDEX_BATCH = 100;
/** Retry backoff for failed index jobs: 1, 2, 4 … minutes, capped at an hour. */
const indexRetryMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 60 * 60_000);
/** Background area-labeling jobs per alarm, and attempts before one is given up (the memory stays general). */
const AREA_JOB_BATCH = 10, AREA_JOB_MAX_ATTEMPTS = 5;
const now = () => new Date().toISOString();
const newId = (p = "mem") => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * One vault = one Durable Object (SQLite backend). Address with
 * env.MEMORY_VAULT.getByName("personal"). All methods are public RPC.
 */
export class MemoryVault extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Memories a sync pass in this instance is working on, so concurrent passes don't race on them. */
  private indexing = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Daily history cleanup and index retries run on a Durable Object alarm; make sure schema and alarm are ready.
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.scheduleAlarm();
    });
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('fact','preference','decision','task','note','project')),
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('active','proposed','superseded','rejected')),
        supersedes TEXT, source TEXT, content_hash TEXT NOT NULL, batch_id TEXT,
        source_date TEXT, confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mem_upd ON memories(updated_at);
      CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(content_hash);
      CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_mem_batch ON memories(batch_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TABLE IF NOT EXISTS operating_guide (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guide_history (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exclusions (id TEXT PRIMARY KEY, pattern_hash TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_excl_hash ON exclusions(pattern_hash);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, source TEXT, added INTEGER NOT NULL, created_at TEXT NOT NULL, undone_at TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, memory_id TEXT, actor TEXT, details TEXT, timestamp TEXT NOT NULL);
    `);
    // v2: keep a copy of each embedding so freshly written rows are searchable before Vectorize ingests them.
    const cols = this.sql.exec(`PRAGMA table_info(memories)`).toArray().map((r) => r.name);
    if (!cols.includes("embedding")) this.sql.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`);
    // v3: near-duplicate link from bulk import.
    if (!cols.includes("similar_to")) this.sql.exec(`ALTER TABLE memories ADD COLUMN similar_to TEXT`);
    // v4: durable search-index sync. embedded_hash = the content_hash the stored embedding was made from;
    // index_jobs = memories whose Vectorize entry must be brought up to date (retried until it succeeds).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS index_jobs (memory_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 1,
      reembed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_next ON index_jobs(next_at)`);
    // v5: revoked OAuth grants. KV (where the OAuth library keeps grants) is eventually consistent, and a refresh
    // racing a revoke can write a grant back; this strongly consistent list is checked on every /mcp request.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS revoked_grants (grant_id TEXT PRIMARY KEY, client_id TEXT, revoked_at TEXT NOT NULL)`);
    // v6: areas (the project or part of life a memory belongs to), labeled by rule in the background.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS areas (name TEXT PRIMARY KEY, aliases TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '', embedding BLOB, created_by TEXT NOT NULL, created_at TEXT NOT NULL)`);
    // Memories the rules left general, to be labeled in the background (by embedding, then a small model).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS area_jobs (memory_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT)`);
    const addAreas = !cols.includes("area");
    if (addAreas) {
      this.sql.exec(`ALTER TABLE memories ADD COLUMN area TEXT`);
      this.sql.exec(`ALTER TABLE memories ADD COLUMN area_source TEXT`);
      this.sql.exec(`ALTER TABLE memories ADD COLUMN area_hint TEXT`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_mem_area ON memories(area, status)`);
    // v7: a memory's area name and aliases are searchable by keyword too, in a second, lower-weighted FTS column.
    // v9: words are stemmed (porter), so "live" also finds "lives".
    if (!cols.includes("area_terms")) this.sql.exec(`ALTER TABLE memories ADD COLUMN area_terms TEXT`);
    const ftsSql = String(this.sql.exec(`SELECT sql FROM sqlite_master WHERE name = 'memories_fts'`).one().sql);
    if (!ftsSql.includes("area_terms") || !ftsSql.includes("porter")) {
      this.sql.exec(`DROP TRIGGER IF EXISTS memories_ai; DROP TRIGGER IF EXISTS memories_ad; DROP TRIGGER IF EXISTS memories_au; DROP TABLE memories_fts;
        CREATE VIRTUAL TABLE memories_fts USING fts5(content, area_terms, content='memories', content_rowid='rowid', tokenize='porter unicode61');
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, area_terms) VALUES (new.rowid, new.content, new.area_terms);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, area_terms) VALUES ('delete', old.rowid, old.content, old.area_terms);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE OF content, area_terms ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, area_terms) VALUES ('delete', old.rowid, old.content, old.area_terms);
          INSERT INTO memories_fts(rowid, content, area_terms) VALUES (new.rowid, new.content, new.area_terms);
        END;
        INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');`);
    }
    if (!cols.includes("embedded_hash")) {
      this.sql.exec(`ALTER TABLE memories ADD COLUMN embedded_hash TEXT`);
      // Existing embeddings are assumed current; a full re-embed is available from the UI (reindex).
      this.sql.exec(`UPDATE memories SET embedded_hash = content_hash WHERE embedding IS NOT NULL`);
      // Rows that never got an embedding (written during an outage) are queued now.
      this.sql.exec(`INSERT OR IGNORE INTO index_jobs(memory_id, next_at)
        SELECT id, ? FROM memories WHERE embedding IS NULL AND status != 'rejected'`, now());
    }
    const t = now();
    this.sql.exec(`INSERT OR IGNORE INTO settings(key, value) VALUES ('approval_mode', 'review')`);
    if (this.sql.exec(`SELECT 1 FROM operating_guide WHERE id = 1`).toArray().length === 0) {
      const guide = defaultGuide(this.env.OWNER_NAME);
      this.sql.exec(`INSERT INTO operating_guide(id, content, version, updated_at) VALUES (1, ?, 1, ?)`, guide, t);
      this.sql.exec(`INSERT INTO guide_history(version, content, updated_at, actor) VALUES (1, ?, ?, 'system')`, guide, t);
    }
    if (addAreas) this.relabelAreas("backfill");
    // v8: labels from an area named in the text are no longer a rule; those memories go to the model instead.
    const named = this.sql.exec(`SELECT id FROM memories WHERE area_source = 'content'`).toArray();
    if (named.length) {
      for (const r of named) this.writeArea(r.id as string, null, null, null);
      this.relabelAreas("relabel-named");
    }
  }

  // ---------- areas ----------
  private areaDefs(): AreaDef[] {
    return this.sql.exec(`SELECT name, aliases FROM areas ORDER BY name`).toArray()
      .map((r) => ({ name: r.name as string, aliases: JSON.parse(r.aliases as string) as string[] }));
  }

  /** Set a memory's area and its keyword-search terms (the area's name and aliases). Not an edit: updated_at stays. */
  private writeArea(id: string, area: string | null, source: string | null, hint: string | null, contentHash?: string) {
    this.sql.exec(`UPDATE memories SET area = ?, area_source = ?, area_hint = ?, area_terms = ? WHERE id = ?${contentHash ? " AND content_hash = ?" : ""}`,
      area, source, hint, this.areaTerms(area), id, ...(contentHash ? [contentHash] : []));
  }
  private areaTerms(area: string | null): string | null {
    if (!area) return null;
    const r = this.sql.exec(`SELECT aliases FROM areas WHERE name = ?`, area).toArray()[0];
    return [area, ...(r ? (JSON.parse(r.aliases as string) as string[]) : [])].map((t) => t.replace(/-/g, " ")).join(" ");
  }
  private refreshAreaTerms(area: string) {
    this.sql.exec(`UPDATE memories SET area_terms = ? WHERE area = ?`, this.areaTerms(area), area);
  }

  /** Area names the owner removed: never created again, and treated as "general" when suggested. */
  private blockedAreas(): string[] {
    const r = this.sql.exec(`SELECT value FROM settings WHERE key = 'blocked_areas'`).toArray()[0];
    return r ? (JSON.parse(r.value as string) as string[]) : [];
  }
  private setBlockedAreas(names: string[]) {
    this.sql.exec(`INSERT INTO settings(key, value) VALUES ('blocked_areas', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify([...new Set(names)].sort()));
  }

  /**
   * Label one memory by the area rules (pickArea). An agent's choice sticks until an agent changes it, and the
   * model's label sticks until the content changes (`reset`). A memory the rules leave
   * general is queued for background labeling.
   */
  private labelArea(id: string, opts: { explicit?: string | null; areas?: AreaDef[]; run?: string; reset?: boolean } = {}) {
    const m = this.sql.exec(`SELECT content, type, source, status, content_hash, supersedes, area, area_source, area_hint,
        (SELECT o.area FROM memories o WHERE o.id = memories.supersedes) AS inherited FROM memories WHERE id = ?`, id).toArray()[0];
    if (!m) return;
    // The owner's choice (or undo) is never changed automatically.
    if (m.area_source === "owner") { this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, id); return; }
    const areas = opts.areas ?? this.areaDefs();
    const background = !opts.reset && m.area_source === "model";
    if (background && m.area && !opts.explicit) return;
    const explicit = opts.explicit ?? (m.area_source === "agent" ? ((m.area ?? m.area_hint) as string | null) : null);
    let pick: { area: string | null; source: string | null; hint: string | null } = pickArea(
      m as { content: string; type: string; source: string | null }, { explicit, inherited: m.inherited as string | null }, areas);
    // The model already looked at this memory: keep its verdict, and use its suggested name once that is an area.
    if (background && !pick.area && !explicit) {
      const named = m.area_hint ? resolveArea(m.area_hint as string, areas) : null;
      pick = named ? { area: named, source: "model", hint: null } : { area: null, source: "model", hint: m.area_hint as string | null };
    }
    if (pick.hint && this.blockedAreas().includes(pick.hint)) pick = { ...pick, hint: null };
    if (pick.area !== m.area || pick.source !== m.area_source || pick.hint !== m.area_hint) {
      this.writeArea(id, pick.area, pick.source, pick.hint);
      if (pick.area !== m.area) this.audit("area", id, "system", { from: m.area, to: pick.area, by: pick.source, run: opts.run ?? id });
    }
    const live = m.status === "active" || m.status === "proposed";
    if (!pick.area && live && pick.source !== "agent" && pick.source !== "model")
      this.sql.exec(`INSERT INTO area_jobs(memory_id, content_hash, next_at) VALUES (?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET content_hash = excluded.content_hash, attempts = 0, next_at = excluded.next_at, last_error = NULL
        WHERE area_jobs.content_hash != excluded.content_hash`, id, m.content_hash, now());
    else this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, id);
  }

  /** Create an area for each name AREA_MIN_MEMORIES live memories point to, then label general memories again. */
  private promoteAreas(run = `write-${now()}`, relabel = false) {
    const ready = this.sql.exec(`SELECT area_hint AS name FROM memories WHERE area IS NULL AND area_hint IS NOT NULL
        AND status IN ('active','proposed') GROUP BY area_hint HAVING COUNT(*) >= ?`, AREA_MIN_MEMORIES).toArray();
    if (!ready.length && !relabel) return;
    const blocked = this.blockedAreas();
    for (const r of ready) {
      if (blocked.includes(r.name as string) || this.sql.exec(`SELECT 1 FROM areas WHERE name = ?`, r.name).toArray().length) continue;
      this.sql.exec(`INSERT INTO areas(name, created_by, created_at) VALUES (?, 'auto', ?)`, r.name, now());
      this.audit("area_created", null, "system", { name: r.name, run });
    }
    const areas = this.areaDefs();
    for (const r of this.sql.exec(
      `SELECT id FROM memories WHERE area IS NULL AND (area_source IS NULL OR area_hint IS NOT NULL OR supersedes IS NOT NULL OR instr(lower(coalesce(source, '')), 'repo') > 0)`,
    ).toArray())
      this.labelArea(r.id as string, { areas, run });
  }

  /** Label every memory again, e.g. after the areas migration or a restore. */
  private relabelAreas(run: string) {
    const areas = this.areaDefs();
    // Oldest first, so a replacement inherits its predecessor's area.
    for (const r of this.sql.exec(`SELECT id FROM memories ORDER BY created_at`).toArray()) this.labelArea(r.id as string, { areas, run });
    this.promoteAreas(run);
  }

  /**
   * Label memories the rules left general, in the background (alarm), by asking AREA_MODEL. Not by embedding: on a
   * real vault that put memories into the closest existing area before their own area existed (HodlJuice into LFKai).
   * Failures leave the memory general and retry with backoff.
   */
  private async labelAreasInBackground() {
    await this.describeAreas();
    const jobs = this.sql.exec(
      `SELECT j.memory_id, j.content_hash, j.attempts FROM area_jobs j LEFT JOIN memories m ON m.id = j.memory_id
       WHERE j.next_at <= ? ORDER BY (m.type = 'preference'), j.next_at LIMIT ?`,
      now(), AREA_JOB_BATCH,
    ).toArray();
    if (!jobs.length) return;
    const areas = this.areaDefs();
    const vecs = this.areaVectors();
    const blocked = this.blockedAreas();
    const run = `background-${now()}`;
    let changed = false;
    for (const j of jobs) {
      const id = j.memory_id as string, hash = j.content_hash as string;
      const m = this.sql.exec(`SELECT content, type, status, content_hash, area, area_source FROM memories WHERE id = ?`, id).toArray()[0];
      if (!m || m.content_hash !== hash || m.area || m.area_source === "agent" || m.area_source === "owner" || (m.status !== "active" && m.status !== "proposed")) {
        this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, id);
        continue;
      }
      try {
        const names = await this.askAreaModel(m as { content: string; type: string }, areas);
        let pick: { area: string | null; hint: string | null; source: string } = { area: null, hint: null, source: "model" };
        const suggested = names.length === 1 ? normalizeArea(names[0]) : null;
        const name = suggested && !blocked.includes(suggested) ? suggested : null;
        if (name) {
          const direct = resolveArea(name, areas);
          const learned = direct ? null : await this.learnAlias(name, areas, vecs);
          const known = direct ?? learned?.area ?? null;
          if (learned?.added) changed = true;
          // An existing area only after a second yes/no check. A new name only counts toward creating that area,
          // and never for a preference.
          if (known) {
            if (await this.confirmArea(m as { content: string; type: string }, known)) pick = { area: known, hint: null, source: "model" };
          } else if (m.type !== "preference") pick = { area: null, hint: name, source: "model" };
        }
        // Only if the memory didn't change while the model was answering.
        this.writeArea(id, pick.area, pick.source, pick.hint, hash);
        if (pick.area) this.audit("area", id, "system", { from: null, to: pick.area, by: pick.source, run });
        this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ? AND content_hash = ?`, id, hash);
      } catch (e) {
        const attempts = (j.attempts as number) + 1;
        if (attempts >= AREA_JOB_MAX_ATTEMPTS) {
          this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, id);
          this.audit("area_gave_up", id, "system", { error: (e as Error).message });
        } else this.sql.exec(`UPDATE area_jobs SET attempts = ?, next_at = ?, last_error = ? WHERE memory_id = ?`,
          attempts, new Date(Date.now() + indexRetryMs(attempts)).toISOString(), (e as Error).message, id);
      }
    }
    // New aliases can match general memories by name; new hints can reach AREA_MIN_MEMORIES.
    this.promoteAreas(run, changed);
  }

  /** Ask AREA_MODEL which area a memory is about. Throws when the model is unavailable or answers nonsense. */
  private async askAreaModel(m: { content: string; type: string }, areas: AreaDef[]): Promise<string[]> {
    const described = this.sql.exec(`SELECT name, description FROM areas ORDER BY name`).toArray() as { name: string; description: string }[];
    const r = await withTimeout(this.env.AI.run(AREA_MODEL as any, {
      messages: [{ role: "user", content: areaLabelPrompt(m, described.length ? described : areas.map((a) => ({ name: a.name, description: "" }))) }],
      max_tokens: 40, temperature: 0,
    }), AI_TIMEOUT_MS, "area model");
    const names = parseAreaNames(chatText(r));
    if (!names) throw new Error("area model gave no usable answer");
    return names;
  }

  /** Ask AREA_MODEL to confirm a placement: for a preference, that it applies only in that area. */
  private async confirmArea(m: { content: string; type: string }, area: string): Promise<boolean> {
    const a = this.sql.exec(`SELECT name, description FROM areas WHERE name = ?`, area).toArray()[0] as { name: string; description: string };
    const prompt = m.type === "preference" ? areaPreferencePrompt(m.content, a) : areaConfirmPrompt(m.content, a);
    const r = await withTimeout(this.env.AI.run(AREA_MODEL as any, {
      messages: [{ role: "user", content: prompt }], max_tokens: 5, temperature: 0,
    }), AI_TIMEOUT_MS, "area model");
    const answer = chatText(r).toLowerCase();
    if (!/^(yes|no)\b/.test(answer)) throw new Error("area model gave no usable answer");
    return answer.startsWith("yes");
  }

  /** A name the model suggests that is really an existing area: record it as an alias and return the area. */
  private async learnAlias(name: string, areas: AreaDef[], vecs: { name: string; vec: Float32Array }[]): Promise<{ area: string; added: boolean } | null> {
    let area = aliasOf(name, areas);
    if (!area && vecs.length) {
      const v = await this.embed([name.replace(/-/g, " ")]);
      if (v) area = closestArea(v[0], vecs, AREA_ALIAS_SIM, 0);
    }
    if (!area) return null;
    const def = areas.find((a) => a.name === area)!;
    const added = !def.aliases.includes(name);
    if (added) {
      def.aliases.push(name);
      this.sql.exec(`UPDATE areas SET aliases = ? WHERE name = ?`, JSON.stringify(def.aliases), area);
      this.refreshAreaTerms(area);
      this.audit("area_alias", null, "system", { area, alias: name });
    }
    return { area, added };
  }

  /** Write a one-line description for areas that lack one (AREA_MODEL) and embed it, for matching by embedding. */
  private async describeAreas() {
    for (const a of this.sql.exec(`SELECT name, description FROM areas WHERE embedding IS NULL ORDER BY created_at LIMIT 3`).toArray()) {
      const name = a.name as string;
      let description = a.description as string;
      if (!description) {
        const samples = this.sql.exec(`SELECT content FROM memories WHERE area = ? AND status IN ('active','proposed') ORDER BY updated_at DESC LIMIT 8`, name)
          .toArray().map((r) => r.content as string);
        try {
          const r = await withTimeout(this.env.AI.run(AREA_MODEL as any, {
            messages: [{ role: "user", content: areaDescriptionPrompt(name, samples) }], max_tokens: 60, temperature: 0,
          }), AI_TIMEOUT_MS, "area model");
          description = chatText(r).split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 200);
        } catch (e) { console.warn("area description failed:", (e as Error).message); }
        if (!description) continue; // retried on the next alarm
      }
      const v = await this.embed([`${name.replace(/-/g, " ")}: ${description}`]);
      this.sql.exec(`UPDATE areas SET description = ?, embedding = ? WHERE name = ?`, description, v ? new Float32Array(v[0]).buffer : null, name);
    }
  }

  private areaVectors(): { name: string; vec: Float32Array }[] {
    return this.sql.exec(`SELECT name, embedding FROM areas WHERE embedding IS NOT NULL`).toArray()
      .map((r) => ({ name: r.name as string, vec: new Float32Array(r.embedding as ArrayBuffer) }));
  }

  // ---------- areas: owner actions (dashboard) ----------
  /** The owner sets a memory's area (null or "general" = no area). A new name creates the area. The choice sticks. */
  async setMemoryArea(id: string, area: string | null, actor = "ui") {
    const m = this.get(id);
    if (!m) return { ok: false, error: "not found" };
    const general = area === null || area.trim().toLowerCase() === "general";
    const name = general ? null : normalizeArea(area);
    if (!general && !name) return { ok: false, error: "that name is too generic or empty for an area" };
    const target = name ? resolveArea(name, this.areaDefs()) ?? name : null;
    if (target && !this.sql.exec(`SELECT 1 FROM areas WHERE name = ?`, target).toArray().length) {
      this.sql.exec(`INSERT INTO areas(name, created_by, created_at) VALUES (?, 'owner', ?)`, target, now());
      this.setBlockedAreas(this.blockedAreas().filter((b) => b !== target));
      this.audit("area_created", null, actor, { name: target });
    }
    this.writeArea(id, target, "owner", null);
    this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, id);
    this.audit("area", id, actor, { from: m.area, to: target, by: "owner" });
    await this.scheduleAlarm(); // a new area gets its description
    return { ok: true, area: target };
  }

  /**
   * Move every memory of `from` into `into` and keep `from` (and its aliases) as aliases of `into`, so it is never
   * created again. Into a new name, this is a rename.
   */
  async mergeArea(from: string, into: string, actor = "ui") {
    const src = normalizeArea(from), dst = normalizeArea(into);
    const a = src ? this.sql.exec(`SELECT * FROM areas WHERE name = ?`, src).toArray()[0] : undefined;
    if (!a) return { ok: false, error: `no area named ${from}` };
    if (!dst) return { ok: false, error: "that name is too generic or empty for an area" };
    const target = resolveArea(dst, this.areaDefs().filter((d) => d.name !== src)) ?? dst;
    if (target === src) return { ok: false, error: "that is the same area" };
    const aliases = [...(JSON.parse(a.aliases as string) as string[]), src!];
    const existing = this.sql.exec(`SELECT aliases FROM areas WHERE name = ?`, target).toArray()[0];
    if (existing) {
      const merged = [...new Set([...(JSON.parse(existing.aliases as string) as string[]), ...aliases])].filter((x) => x !== target);
      this.sql.exec(`UPDATE areas SET aliases = ? WHERE name = ?`, JSON.stringify(merged), target);
    } else {
      // A rename keeps the description and its embedding.
      this.sql.exec(`INSERT INTO areas(name, aliases, description, embedding, created_by, created_at) VALUES (?, ?, ?, ?, 'owner', ?)`,
        target, JSON.stringify(aliases.filter((x) => x !== target)), a.description, a.embedding, now());
    }
    const moved = this.sql.exec(`SELECT COUNT(*) AS n FROM memories WHERE area = ?`, src).one().n as number;
    this.sql.exec(`UPDATE memories SET area = ? WHERE area = ?`, target, src);
    this.sql.exec(`DELETE FROM areas WHERE name = ?`, src);
    this.setBlockedAreas(this.blockedAreas().filter((b) => b !== target));
    this.refreshAreaTerms(target);
    this.audit(existing ? "area_merge" : "area_rename", null, actor, { from: src, into: target, memories: moved });
    return { ok: true, into: target, memories: moved, renamed: !existing };
  }

  /** Remove an area: its memories become general (and are labeled again), and the name is never created again. */
  async removeArea(name: string, actor = "ui") {
    const n = normalizeArea(name);
    if (!n || !this.sql.exec(`SELECT 1 FROM areas WHERE name = ?`, n).toArray().length) return { ok: false, error: `no area named ${name}` };
    const ids = this.sql.exec(`SELECT id FROM memories WHERE area = ?`, n).toArray().map((r) => r.id as string);
    this.sql.exec(`DELETE FROM areas WHERE name = ?`, n);
    this.setBlockedAreas([...this.blockedAreas(), n]);
    for (const id of ids) this.writeArea(id, null, null, null);
    const areas = this.areaDefs();
    for (const id of ids) this.labelArea(id, { areas, run: `remove-${n}` });
    this.audit("area_removed", null, actor, { name: n, memories: ids.length });
    await this.scheduleAlarm();
    return { ok: true, memories: ids.length };
  }

  async removedAreas() { return this.blockedAreas(); }

  /** Allow a removed area name to be created again: general memories are labeled afresh, so it can come back. */
  async unblockArea(name: string, actor = "ui") {
    const n = normalizeArea(name);
    this.setBlockedAreas(this.blockedAreas().filter((b) => b !== n));
    for (const r of this.sql.exec(`SELECT id FROM memories WHERE area IS NULL AND (area_source IS NULL OR area_source = 'model')`).toArray())
      this.writeArea(r.id as string, null, null, null);
    this.relabelAreas(`unblock-${n}`);
    this.audit("area_unblocked", null, actor, { name: n });
    await this.scheduleAlarm();
    return { ok: true };
  }

  /** Recent automatic labeling runs (from the audit log), newest first. */
  async areaRuns(limit = 20) {
    return this.sql.exec(`SELECT json_extract(details, '$.run') AS run, COUNT(*) AS changes, MIN(timestamp) AS started, MAX(timestamp) AS finished,
        SUM(json_extract(details, '$.undone') IS NOT NULL) AS undone
      FROM audit WHERE action = 'area' AND actor = 'system' AND json_extract(details, '$.run') IS NOT NULL
      GROUP BY run ORDER BY finished DESC LIMIT ?`, limit).toArray();
  }

  /**
   * Undo an automatic labeling run: each memory it changed goes back to its earlier area, unless it changed again
   * since. The restored labels count as the owner's, so they stick.
   */
  async undoAreaRun(run: string, actor = "ui") {
    const rows = this.sql.exec(`SELECT id, memory_id, details FROM audit WHERE action = 'area' AND actor = 'system'
        AND json_extract(details, '$.run') = ? AND json_extract(details, '$.undone') IS NULL ORDER BY id DESC`, run).toArray();
    let restored = 0;
    for (const r of rows) {
      const d = JSON.parse(r.details as string) as { from: string | null; to: string | null };
      const m = this.get(r.memory_id as string);
      if (m && m.area === d.to) {
        const back = d.from && this.sql.exec(`SELECT 1 FROM areas WHERE name = ?`, d.from).toArray().length ? d.from : null;
        this.writeArea(m.id, back, "owner", null);
        this.sql.exec(`DELETE FROM area_jobs WHERE memory_id = ?`, m.id);
        restored++;
      }
      this.sql.exec(`UPDATE audit SET details = json_set(details, '$.undone', ?) WHERE id = ?`, now(), r.id);
    }
    this.audit("area_undo", null, actor, { run, restored });
    return { ok: true, restored };
  }

  async listAreas() {
    return this.sql.exec(`SELECT a.name, a.aliases, a.description, a.created_by, a.created_at,
        (SELECT COUNT(*) FROM memories m WHERE m.area = a.name AND m.status IN ('active','proposed')) AS memories
      FROM areas a ORDER BY a.name`).toArray()
      .map((r) => ({
        name: r.name as string, aliases: JSON.parse(r.aliases as string) as string[], description: r.description as string,
        created_by: r.created_by as string, created_at: r.created_at as string, memories: r.memories as number,
      }));
  }

  // ---------- internals ----------
  private audit(action: string, memoryId: string | null, actor = "system", details?: unknown) {
    this.sql.exec(`INSERT INTO audit(action, memory_id, actor, details, timestamp) VALUES (?, ?, ?, ?, ?)`,
      action, memoryId, actor, details === undefined ? null : JSON.stringify(details), now());
  }
  private get(id: string): Memory | null {
    return (this.sql.exec(`SELECT ${COLS} FROM memories WHERE id = ?`, id).toArray()[0] as unknown as Memory) ?? null;
  }
  private isExcluded(hash: string) {
    return this.sql.exec(`SELECT 1 FROM exclusions WHERE pattern_hash = ? LIMIT 1`, hash).toArray().length > 0;
  }
  private findByHash(hash: string): Memory | null {
    // Copies can exist (a restated fact next to its superseded original), so prefer the current one.
    return (this.sql.exec(`SELECT ${COLS} FROM memories WHERE content_hash = ? AND status != 'rejected'
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END LIMIT 1`, hash).toArray()[0] as unknown as Memory) ?? null;
  }

  /** Embed texts; returns null (never throws) if Workers AI is unavailable. */
  private async embed(texts: string[]): Promise<number[][] | null> {
    try {
      const out: number[][] = [];
      for (const part of chunk(texts, 50)) {
        const r = (await withTimeout(this.env.AI.run(EMBED_MODEL as any, { text: part }), AI_TIMEOUT_MS, "embedding")) as { data?: number[][] };
        if (!r?.data || r.data.length !== part.length) return null;
        out.push(...r.data);
      }
      return out;
    } catch (e) {
      console.warn("embedding unavailable:", (e as Error).message);
      return null;
    }
  }
  /**
   * Queue memories whose search-index entry must change (new, edited, status/type changed, or deleted).
   * Call it in the same synchronous step as the change, so the need to sync is stored with the change.
   */
  private queueIndex(ids: string[], reembed = false) {
    const t = now();
    for (const id of new Set(ids))
      this.sql.exec(`INSERT INTO index_jobs(memory_id, seq, reembed, attempts, next_at) VALUES (?, 1, ?, 0, ?)
        ON CONFLICT(memory_id) DO UPDATE SET seq = seq + 1, reembed = max(reembed, excluded.reembed), attempts = 0,
          next_at = excluded.next_at, last_error = NULL`, id, reembed ? 1 : 0, t);
  }

  /**
   * Bring Vectorize up to date for queued memories: the given ids, or every due job (up to INDEX_BATCH).
   * A memory that exists and isn't rejected is upserted (re-embedding only if its stored embedding is
   * not for its current content); otherwise its vector is deleted. Never throws: failures stay queued
   * with backoff and the alarm retries them. A job is only cleared if the memory didn't change meanwhile.
   */
  private async syncIndex(ids?: string[]): Promise<{ indexed: number; pending: number; error?: string }> {
    type Job = { memory_id: string; seq: number; reembed: number; attempts: number };
    const jobs = ((ids
      ? [...new Set(ids)].flatMap((id) => this.sql.exec(`SELECT memory_id, seq, reembed, attempts FROM index_jobs WHERE memory_id = ?`, id).toArray())
      : this.sql.exec(`SELECT memory_id, seq, reembed, attempts FROM index_jobs WHERE next_at <= ? ORDER BY next_at LIMIT ?`, now(), INDEX_BATCH).toArray()
    ) as unknown as Job[]).filter((j) => !this.indexing.has(j.memory_id));
    if (!jobs.length) return { indexed: 0, pending: 0 };
    for (const j of jobs) this.indexing.add(j.memory_id);
    const errors = new Map<string, string>();
    try {
      type Upsert = { job: Job; id: string; hash: string; type: string; status: string; content: string; vec: number[] | null };
      const upserts: Upsert[] = []; const deletes: Job[] = [];
      for (const job of jobs) {
        const r = this.sql.exec(`SELECT id, content, type, status, content_hash, embedded_hash, embedding FROM memories WHERE id = ?`, job.memory_id).toArray()[0];
        if (!r || r.status === "rejected") { deletes.push(job); continue; }
        const current = !job.reembed && r.embedding && r.embedded_hash === r.content_hash;
        upserts.push({
          job, id: r.id as string, hash: r.content_hash as string, type: r.type as string, status: r.status as string, content: r.content as string,
          vec: current ? Array.from(new Float32Array(r.embedding as ArrayBuffer)) : null,
        });
      }
      const toEmbed = upserts.filter((u) => !u.vec);
      if (toEmbed.length) {
        const vecs = await this.embed(toEmbed.map((u) => u.content));
        toEmbed.forEach((u, i) => {
          if (!vecs) { errors.set(u.id, "embedding unavailable"); return; }
          u.vec = vecs[i];
          // Only store it if the content is still what was embedded; an edit meanwhile queued a newer job.
          this.sql.exec(`UPDATE memories SET embedding = ?, embedded_hash = ? WHERE id = ? AND content_hash = ?`,
            new Float32Array(vecs[i]).buffer, u.hash, u.id, u.hash);
        });
      }
      const ready = upserts.filter((u) => u.vec);
      for (const part of chunk(ready, 500)) {
        try { await withTimeout(this.env.VECTORIZE.upsert(part.map((u) => ({ id: u.id, values: u.vec!, metadata: { type: u.type, status: u.status } }))), VECTORIZE_TIMEOUT_MS, "vectorize upsert"); }
        catch (e) { for (const u of part) errors.set(u.id, `vectorize upsert failed: ${(e as Error).message}`); }
      }
      for (const part of chunk(deletes, 500)) {
        try { await withTimeout(this.env.VECTORIZE.deleteByIds(part.map((j) => j.memory_id)), VECTORIZE_TIMEOUT_MS, "vectorize delete"); }
        catch (e) { for (const j of part) errors.set(j.memory_id, `vectorize delete failed: ${(e as Error).message}`); }
      }
    } finally {
      for (const j of jobs) this.indexing.delete(j.memory_id);
    }
    let indexed = 0;
    const t = Date.now();
    for (const j of jobs) {
      const err = errors.get(j.memory_id);
      if (err) {
        this.sql.exec(`UPDATE index_jobs SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE memory_id = ? AND seq = ?`,
          new Date(t + indexRetryMs(j.attempts + 1)).toISOString(), err, j.memory_id, j.seq);
        continue;
      }
      // A changed seq means the memory changed while we worked: leave that job for the next pass.
      this.sql.exec(`DELETE FROM index_jobs WHERE memory_id = ? AND seq = ?`, j.memory_id, j.seq);
      indexed++;
    }
    if (errors.size) console.warn("index sync failed for", errors.size, "memories:", [...new Set(errors.values())].join("; "));
    const pending = jobs.length - indexed;
    // Retries (and jobs that changed mid-sync) are due later; make sure the alarm will come back for them.
    if (pending || jobs.some((j) => this.sql.exec(`SELECT 1 FROM index_jobs WHERE memory_id = ?`, j.memory_id).toArray().length)) await this.scheduleAlarm();
    return { indexed, pending, ...(errors.size ? { error: [...new Set(errors.values())][0] } : {}) };
  }

  /** Queue and sync in one step; the result is what write responses report. */
  private async indexNow(ids: string[]) {
    this.queueIndex(ids);
    return this.indexReport(await this.syncIndex(ids));
  }
  private indexReport(r: { indexed: number; pending: number; error?: string }) {
    return r.pending
      ? { index_pending: r.pending, warning: `search index update pending (${r.error ?? "busy"}); it retries automatically, and keyword search works meanwhile` }
      : { indexed: r.indexed };
  }

  /** Alarm at the earlier of the next daily cleanup and the next due index or area job (or an area to describe). */
  private async scheduleAlarm() {
    const cleanupAt = this.nextCleanupAt();
    const jobAt = this.sql.exec(`SELECT MIN(t) AS t FROM (SELECT MIN(next_at) AS t FROM index_jobs UNION ALL SELECT MIN(next_at) FROM area_jobs
        UNION ALL SELECT CASE WHEN EXISTS (SELECT 1 FROM areas WHERE embedding IS NULL) THEN ? END)`,
      new Date(Date.now() + 60_000).toISOString()).one().t as string | null;
    const at = jobAt ? Math.min(cleanupAt, Math.max(Date.parse(jobAt), Date.now() + 1000)) : cleanupAt;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }
  private nextCleanupAt(): number {
    const r = this.sql.exec(`SELECT value FROM settings WHERE key = 'next_cleanup_at'`).toArray()[0];
    if (r) return Number(r.value);
    const at = Date.now() + 60_000;
    this.sql.exec(`INSERT INTO settings(key, value) VALUES ('next_cleanup_at', ?)`, String(at));
    return at;
  }

  private approvalMode(): "review" | "auto" {
    const r = this.sql.exec(`SELECT value FROM settings WHERE key = 'approval_mode'`).toArray()[0];
    return r?.value === "auto" ? "auto" : "review";
  }

  // ---------- writes ----------
  async remember(input: {
    content: string; type?: string; source?: string; status?: string; supersedes?: string;
    source_date?: string; area?: string; actor?: string;
  }) {
    const actor = input.actor ?? "agent";
    const content = (input.content ?? "").trim();
    if (!content) return { ok: false, error: "content is empty" };
    if (content.length > MAX_CONTENT_LEN) return { ok: false, error: `content too long (max ${MAX_CONTENT_LEN} chars); split into separate memories` };
    if (looksLikeSecret(content)) {
      this.audit("reject_secret", null, actor, { reason: "looks like a secret; content not stored" });
      return { ok: false, status: "rejected", error: "Content looks like a secret/credential and was NOT stored." };
    }
    const meta = metadataProblem(input);
    if (meta?.kind === "secret") {
      this.audit("reject_secret", null, actor, { reason: "metadata looks like a secret; not stored" });
      return { ok: false, status: "rejected", error: meta.error };
    }
    if (meta) return { ok: false, error: meta.error };
    const hash = await contentHash(content);
    if (this.isExcluded(hash)) return { ok: false, status: "excluded", error: "Content matches a forget/exclusion record and was not stored." };

    let supersedes: string | null = null;
    if (input.supersedes) {
      const old = this.get(input.supersedes);
      if (!old) return { ok: false, error: `supersedes: memory ${input.supersedes} not found` };
      supersedes = old.id;
    }
    const type: MemoryType = isMemoryType(input.type) ? input.type : "note";
    let status: MemoryStatus = this.approvalMode() === "auto" ? "active" : "proposed";
    if (input.status === "proposed") status = "proposed";
    if (input.status === "active" && actor === "ui") status = "active"; // only the owner (UI) may force active
    // In review mode a superseding write waits for approval; in auto mode it takes effect and the old one becomes history.

    // Identical wording already stored. A plain repeat is a no-op, but a replacement or a restated old fact
    // is a lifecycle change, so it still has to happen.
    const dup = this.findByHash(hash);
    let note: string | undefined;
    if (dup) {
      const existing = { ok: true, duplicate: true, id: dup.id, status: dup.status, message: "Identical memory already exists." };
      if (supersedes === dup.id) return existing;
      if (dup.status === "superseded") {
        // Restating wording that was replaced makes it current again, replacing whatever replaced it.
        supersedes ??= this.currentReplacement(dup.id);
        if (!supersedes) return existing;
        note = `This wording was replaced earlier (${dup.id}); stored again so it replaces ${supersedes}.`;
      } else if (!supersedes) {
        return existing;
      } else if (dup.status === "proposed") {
        // Already waiting for approval: approving it will also retire the old memory.
        if (dup.supersedes && dup.supersedes !== supersedes)
          return { ok: false, duplicate: true, id: dup.id, status: dup.status, error: `Identical memory ${dup.id} is pending approval and already set to replace ${dup.supersedes}.` };
        this.sql.exec(`UPDATE memories SET supersedes = ? WHERE id = ?`, supersedes, dup.id);
        this.audit("link_supersedes", dup.id, actor, { supersedes });
        return { ...existing, supersedes, message: `Identical memory is already pending approval; approving it will also replace ${supersedes}.` };
      } else if (status === "active") {
        this.markSuperseded(supersedes, dup.id, actor);
        const idx = await this.indexNow([supersedes]);
        return { ...existing, supersedes, message: `Identical memory is already active; ${supersedes} is now superseded by it.`, ...idx };
      } else {
        // Review mode: store a proposed copy that carries the replacement; approving it merges into the active one.
        note = `Identical memory ${dup.id} is already active; approving this proposal makes it replace ${supersedes}.`;
      }
    }

    const id = newId(); const t = now();
    this.sql.exec(
      `INSERT INTO memories(id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      id, content, type, status, supersedes, input.source ?? null, hash, input.source_date ?? null,
      status === "active" && actor === "ui" ? t : null, t, t);
    if (supersedes && status === "active") this.markSuperseded(supersedes, id, actor);
    this.audit("remember", id, actor, { type, status, supersedes });
    this.labelArea(id, { explicit: input.area });
    this.promoteAreas();
    const area = this.get(id)?.area ?? null;
    const idx = await this.indexNow(supersedes ? [id, supersedes] : [id]);
    await this.scheduleAlarm();
    return { ok: true, id, status, type, supersedes, ...(area ? { area } : {}), ...(note ? { note } : {}), ...idx };
  }

  /** The active memory that (directly or through a chain of replacements) replaced this one, if any. */
  private currentReplacement(id: string): string | null {
    let cur = id;
    for (let i = 0; i < 50; i++) {
      const next = this.sql.exec(`SELECT id, status FROM memories WHERE supersedes = ? AND status IN ('active','superseded') ORDER BY updated_at DESC LIMIT 1`, cur).toArray()[0];
      if (!next) return null;
      if (next.status === "active") return next.id as string;
      cur = next.id as string;
    }
    return null;
  }

  private markSuperseded(oldId: string, byId: string, actor: string) {
    this.sql.exec(`UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND status != 'rejected'`, now(), oldId);
    this.queueIndex([oldId]);
    this.audit("supersede", oldId, actor, { by: byId });
  }

  /**
   * Import many items under one undoable batch. Exact duplicates (normalized hash), excluded and secret-like
   * items are skipped. When embeddings are available, each item is also compared with existing memories
   * (active, proposed, superseded) and with earlier items in the same batch:
   *  - near-identical wording with the same numbers/negations -> skipped as a near-duplicate;
   *  - similar (possibly an update or a contradiction) -> stored with similar_to: 'proposed' for review in review mode,
   *    'active' and flagged as a possible conflict in auto mode;
   *  - otherwise -> stored 'active'.
   */
  async bulkRemember(input: { items?: unknown[]; text?: string; source?: string; actor?: string }) {
    const actor = input.actor ?? "import";
    const batchMeta = metadataProblem({ source: input.source });
    if (batchMeta) return { ok: false, error: batchMeta.error };
    if ((input.items?.length ?? 0) > MAX_IMPORT_ITEMS) return { ok: false, error: `too many items: at most ${MAX_IMPORT_ITEMS} per import; split it into batches` };
    if (typeof input.text === "string" && input.text.length > MAX_IMPORT_TEXT) return { ok: false, error: `text too long: at most ${MAX_IMPORT_TEXT} characters per import; split it into batches` };
    const items: ImportItem[] = input.items ? coerceItems(input.items) : splitImportText(typeof input.text === "string" ? input.text : "");
    if (items.length > MAX_IMPORT_ITEMS) return { ok: false, error: `too many items: the text splits into ${items.length}, at most ${MAX_IMPORT_ITEMS} per import; split it into batches` };
    const batchId = newId("batch"); const t = now();
    const auto = this.approvalMode() === "auto";
    let duplicates = 0, excluded = 0, secrets = 0, invalid = 0;
    const seen = new Set<string>();
    const candidates: (ImportItem & { content: string; hash: string })[] = [];
    for (const it of items) {
      const content = it.content.trim();
      if (!content || content.length > MAX_CONTENT_LEN) { invalid++; continue; }
      if (looksLikeSecret(content)) { secrets++; continue; }
      const meta = metadataProblem(it);
      if (meta) { if (meta.kind === "secret") secrets++; else invalid++; continue; }
      const hash = await contentHash(content);
      if (seen.has(hash) || this.findByHash(hash)) { duplicates++; continue; }
      if (this.isExcluded(hash)) { excluded++; continue; }
      seen.add(hash);
      candidates.push({ ...it, content, hash });
    }

    const vecs = candidates.length ? await this.embed(candidates.map((c) => c.content)) : null;
    type PoolItem = { id: string; content: string; vec: Float32Array };
    const pool: PoolItem[] = [];
    if (vecs) {
      for (const r of this.sql.exec(`SELECT id, content, embedding FROM memories WHERE status IN ('active','proposed','superseded') AND embedding IS NOT NULL AND embedded_hash = content_hash`))
        pool.push({ id: r.id as string, content: r.content as string, vec: unitVector(new Float32Array(r.embedding as ArrayBuffer)) });
    }

    const nearDuplicates: { content: string; matches_id: string; matches: string; similarity: number }[] = [];
    const areas = this.areaDefs();
    const inserted: { id: string; type: string; status: string; content: string }[] = [];
    const review: { id: string; similar_to: string; similarity: number }[] = [];
    candidates.forEach((c, i) => {
      // Check again: a forget or an identical save may have landed while we waited for embeddings.
      // From here to the inserts nothing awaits, so no other request can interleave.
      if (this.isExcluded(c.hash)) { excluded++; return; }
      if (this.findByHash(c.hash)) { duplicates++; return; }
      let status: MemoryStatus = "active";
      let similarTo: string | null = null, similarity = 0;
      let unit: Float32Array | null = null;
      if (vecs) {
        unit = unitVector(vecs[i]);
        const best = bestMatch(unit, pool);
        const verdict = best ? classifySimilarity(best.sim, c.content, best.item.content) : "new";
        if (best && verdict === "near_duplicate") {
          nearDuplicates.push({ content: c.content, matches_id: best.item.id, matches: best.item.content, similarity: Number(best.sim.toFixed(4)) });
          return;
        }
        if (best && verdict === "similar") {
          if (!auto) status = "proposed";
          similarTo = best.item.id;
          similarity = Number(best.sim.toFixed(4));
        }
      }
      const id = newId(); const type = c.type ?? "note";
      this.sql.exec(
        `INSERT INTO memories(id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at, created_at, updated_at, similar_to, embedding, embedded_hash)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        id, c.content, type, status, c.source ?? input.source ?? null, c.hash, batchId, c.source_date ?? null, t, t, similarTo,
        vecs ? new Float32Array(vecs[i]).buffer : null, vecs ? c.hash : null);
      if (similarTo) review.push({ id, similar_to: similarTo, similarity });
      this.labelArea(id, { areas, run: batchId });
      inserted.push({ id, type, status, content: c.content });
      // Later items in the same batch are compared against this one too.
      if (unit) pool.push({ id, content: c.content, vec: unit });
    });

    if (inserted.length) {
      this.sql.exec(`INSERT INTO batches(id, source, added, created_at) VALUES (?, ?, ?, ?)`, batchId, input.source ?? null, inserted.length, t);
      this.promoteAreas(batchId);
    }
    this.audit("bulk_remember", null, actor, {
      batch_id: batchId, added: inserted.length, needs_review: auto ? 0 : review.length, possible_conflicts: auto ? review.length : 0, near_duplicates: nearDuplicates.length,
      duplicates, excluded, secrets, invalid,
    });
    const idx = await this.indexNow(inserted.map((m) => m.id));
    await this.scheduleAlarm();
    return {
      ok: true, batch_id: inserted.length ? batchId : null, total: items.length,
      added: inserted.length, active: auto ? inserted.length : inserted.length - review.length,
      needs_review: auto ? 0 : review.length, possible_conflicts: auto ? review.length : 0, duplicates, near_duplicates: nearDuplicates.length, excluded, secrets_skipped: secrets, invalid,
      ...(vecs ? {} : { dedupe_warning: "embeddings unavailable; only exact duplicates were detected" }),
      [auto ? "conflicts" : "review"]: review.slice(0, 100), near_duplicate_items: nearDuplicates.slice(0, 100),
      ...idx,
    };
  }

  /**
   * Remove a batch's memories. Memories that an approved item from the batch replaced become active again,
   * unless something outside the batch has replaced them since.
   */
  async undoBatch(batchId: string, actor = "ui") {
    const rows = this.sql.exec(`SELECT id, status, supersedes FROM memories WHERE batch_id = ?`, batchId).toArray();
    const ids = rows.map((r) => r.id as string);
    const replaced = [...new Set(rows.filter((r) => r.status === "active" && r.supersedes).map((r) => r.supersedes as string))];
    this.sql.exec(`DELETE FROM memories WHERE batch_id = ?`, batchId);
    const t = now();
    const restored: string[] = [];
    for (const id of replaced) {
      const stillReplaced = this.sql.exec(`SELECT 1 FROM memories WHERE supersedes = ? AND status IN ('active','superseded') LIMIT 1`, id).toArray().length > 0;
      if (stillReplaced || this.get(id)?.status !== "superseded") continue;
      this.sql.exec(`UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?`, t, id);
      restored.push(id);
    }
    this.sql.exec(`UPDATE batches SET undone_at = ? WHERE id = ?`, t, batchId);
    this.audit("undo_batch", null, actor, { batch_id: batchId, removed: ids.length, restored });
    await this.indexNow([...ids, ...restored]);
    return { ok: true, removed: ids.length, restored: restored.length };
  }

  async listBatches() {
    return this.sql.exec(`SELECT b.*, (SELECT COUNT(*) FROM memories m WHERE m.batch_id = b.id) AS remaining FROM batches b ORDER BY created_at DESC LIMIT 100`).toArray();
  }

  // ---------- reads ----------
  /**
   * Hybrid search, with hits in the question's area ranked higher. The area is `input.area`, else the one area
   * the query names. With `complete` (agent recall), the results also hold that whole area (within
   * AREA_ALL_BUDGET_TOKENS) and all general memories (within GENERAL_ALL_BUDGET_TOKENS, else just the general
   * preferences); the result's `complete` lists which were included ("general" or "general preferences").
   */
  async recall(input: { query: string; limit?: number; type?: string; status?: string; area?: string; complete?: boolean }) {
    const areas = this.areaDefs();
    const asked = normalizeArea(input.area);
    const named = areasNamedIn(input.query ?? "", areas);
    const explicitArea = asked ? resolveArea(asked, areas) : named.length === 1 ? named[0] : null;
    const found = await this.search({ ...input, area: explicitArea });
    const area = found.area;
    if (!input.complete) return { mode: found.mode, results: found.results, ...(area ? { area } : {}) };
    const results: (Memory | RecallHit)[] = [...found.results];
    const seen = new Set(results.map((h) => h.id));
    const complete: string[] = [];
    const add = (label: string, rows: Memory[] | null) => {
      if (!rows) return;
      complete.push(label);
      for (const m of rows) if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
    };
    if (area) {
      const whole = this.wholeArea(input, area, AREA_ALL_BUDGET_TOKENS);
      if (whole || input.type) add(area, whole);
      else {
        const prefs = this.wholeArea({ ...input, type: "preference" }, area, AREA_ALL_BUDGET_TOKENS);
        if (prefs?.length) add(`${area} preferences`, prefs);
      }
    }
    const general = this.wholeArea(input, null, GENERAL_ALL_BUDGET_TOKENS);
    if (general || input.type) add("general", general);
    else add("general preferences", this.wholeArea({ ...input, type: "preference" }, null, GENERAL_PREFS_BUDGET_TOKENS, GENERAL_PREFS_MAX_MEMORIES));
    return { mode: found.mode, ...(area ? { area } : {}), complete, results };
  }

  /**
   * Every memory recall may return from one area (null = general), grouped by type and newest first,
   * or null if there are more than `maxRows` or they don't fit in `budgetTokens`.
   */
  private wholeArea(input: { type?: string; status?: string }, area: string | null, budgetTokens: number, maxRows = AREA_ALL_MAX_MEMORIES): Memory[] | null {
    const where = [input.status ? "status = ?" : "status IN ('active','proposed')", area ? "area = ?" : "area IS NULL"];
    const args: unknown[] = input.status ? [input.status] : [];
    if (area) args.push(area);
    if (input.type) { where.push("type = ?"); args.push(input.type); }
    const w = where.join(" AND ");
    const budget = budgetTokens * 4;
    // Count and content length are checked in SQL first, so a large area never loads every row.
    const stat = this.sql.exec(`SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(content)), 0) AS n FROM memories WHERE ${w}`, ...args).one();
    if (Number(stat.c) > maxRows || Number(stat.n) > budget) return null;
    const rows = this.sql.exec(`SELECT ${COLS} FROM memories WHERE ${w} ORDER BY updated_at DESC`, ...args).toArray() as unknown as Memory[];
    if (rows.reduce((n, m) => n + JSON.stringify(slimMemory(m)).length, 0) > budget) return null;
    const rank = (t: string) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);
    return rows.sort((a, b) => rank(a.type) - rank(b.type));
  }

  private async search(input: { query: string; limit?: number; type?: string; status?: string; area?: string | null }) {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
    const query = (input.query ?? "").trim();
    if (!query) return { mode: "none", results: [] as RecallHit[] };
    const allowed = (m: Memory) =>
      (input.type ? m.type === input.type : true) &&
      (input.status ? m.status === input.status : m.status === "active" || m.status === "proposed");
    // Candidates are filtered before the top-20 cut, so history or other types can't crowd out the answer.
    const rows = new Map<string, Memory>();
    const eligible = (id: string) => {
      const m = rows.get(id) ?? this.get(id);
      if (m) rows.set(id, m);
      return !!m && allowed(m);
    };

    // Semantic
    let semantic: string[] = []; let semanticOk = false;
    const sims = new Map<string, number>();
    const qv = await this.embed([query]);
    if (qv) {
      try {
        // No metadata filter on purpose: type/status filtering happens in SQL (the source of truth),
        // so Vectorize metadata indexes are optional. Over-fetch (100 is the max without metadata)
        // so ineligible neighbours don't use up the candidates.
        const res = await withTimeout(this.env.VECTORIZE.query(qv[0], { topK: 100, returnMetadata: "none" }), VECTORIZE_TIMEOUT_MS, "vectorize query");
        for (const m of res.matches) sims.set(m.id, m.score);
        semanticOk = true;
      } catch (e) { console.warn("vectorize query failed:", (e as Error).message); }
      // Vectorize may be missing or behind on recently changed rows and on rows still queued for indexing.
      // For those, trust only a stored embedding of the current content, never Vectorize's (possibly stale) score.
      const since = new Date(Date.now() - FRESH_WINDOW_MS).toISOString();
      for (const r of this.sql.exec(`SELECT id, embedding, content_hash, embedded_hash FROM memories
          WHERE updated_at >= ? OR id IN (SELECT memory_id FROM index_jobs) LIMIT 2000`, since)) {
        const id = r.id as string;
        if (r.embedding && r.embedded_hash === r.content_hash) sims.set(id, cosine(qv[0], new Float32Array(r.embedding as ArrayBuffer)));
        else sims.delete(id);
      }
      semantic = [...sims.entries()].filter(([id, v]) => v >= MIN_SEMANTIC_SIM && eligible(id))
        .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id]) => id);
    }
    // Keyword (FTS5 bm25, lower = better)
    let keywordRows: { id: string; bm25: number }[] = [];
    const match = sanitizeFtsQuery(query);
    if (match) {
      const where = ["memories_fts MATCH ?"]; const args: unknown[] = [match];
      if (input.type) { where.push("m.type = ?"); args.push(input.type); }
      if (input.status) { where.push("m.status = ?"); args.push(input.status); }
      else where.push("m.status IN ('active','proposed')");
      keywordRows = this.sql.exec(
        `SELECT m.id AS id, bm25(memories_fts, 1.0, 0.3) AS bm25 FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE ${where.join(" AND ")} ORDER BY bm25(memories_fts, 1.0, 0.3) LIMIT 20`, ...args).toArray()
        .map((r) => ({ id: r.id as string, bm25: Number(r.bm25) }));
    }
    const keyword = keywordStrengths(keywordRows);
    const semanticSet = new Set(semantic);
    const candidates: { m: Memory; matched: RecallHit["matched"]; similarity?: number; baseScore: number }[] = [];
    for (const id of new Set([...semantic, ...keyword.keys()])) {
      if (!eligible(id)) continue;
      const m = rows.get(id)!;
      const matched: RecallHit["matched"] = [];
      if (semanticSet.has(id)) matched.push("semantic");
      if (keyword.has(id)) matched.push("keyword");
      const similarity = sims.has(id) ? Number(sims.get(id)!.toFixed(4)) : undefined;
      const baseScore = scoreRecallHit({
        similarity: semanticSet.has(id) ? sims.get(id) : undefined, keyword: keyword.get(id),
        status: m.status, updatedAtMs: Date.parse(m.updated_at), inArea: false,
      });
      candidates.push({ m, matched, similarity, baseScore });
    }
    candidates.sort((a, b) => b.baseScore - a.baseScore);
    const area = input.area ?? dominantArea(candidates.slice(0, limit).map((c) => c.m));
    const hits: RecallHit[] = candidates.map(({ m, matched, similarity, baseScore }) => {
      const score = area && m.area === area ? baseScore + AREA_BONUS : baseScore;
      return { ...m, matched, similarity, score: Number(score.toFixed(6)) };
    });
    hits.sort((a, b) => b.score - a.score);
    return { mode: semanticOk ? "hybrid" : "keyword-only", area, results: hits.slice(0, limit) };
  }

  async listMemories(filters: ListFilters = {}, limit = 50, offset = 0) {
    const where: string[] = []; const args: unknown[] = [];
    if (filters.type) { where.push("type = ?"); args.push(filters.type); }
    if (filters.status) { where.push("status = ?"); args.push(filters.status); }
    if (filters.batch_id) { where.push("batch_id = ?"); args.push(filters.batch_id); }
    if (filters.q) { where.push(PHRASE_MATCH); args.push(filters.q); }
    if (filters.area === "general") where.push("area IS NULL");
    else if (filters.area) { where.push("area = ?"); args.push(normalizeArea(filters.area)); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.sql.exec(`SELECT COUNT(*) AS n FROM memories ${w}`, ...args).one().n as number;
    const rows = this.sql.exec(`SELECT ${COLS} FROM memories ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ...args, Math.min(limit, 500), Math.max(offset, 0)).toArray() as unknown as Memory[];
    return { total, limit, offset, memories: rows };
  }

  async getMemory(id: string) { return this.get(id); }

  // ---------- review / edit ----------
  /** Approve a memory. With supersedeSimilar, the memory it was flagged as similar to becomes superseded by it. */
  async approve(id: string, actor = "ui", opts: { supersedeSimilar?: boolean } = {}) {
    let m = this.get(id);
    if (!m) return { ok: false, error: "not found" };
    if (opts.supersedeSimilar) {
      if (!m.similar_to || !this.get(m.similar_to)) return { ok: false, error: "this memory has no similar memory to replace" };
      this.sql.exec(`UPDATE memories SET supersedes = ? WHERE id = ?`, m.similar_to, id);
      m = { ...m, supersedes: m.similar_to };
    }
    // A proposal whose wording is already active (see remember) only carries a replacement: apply it to
    // the active memory and drop the copy.
    const twin = this.sql.exec(`SELECT id FROM memories WHERE content_hash = ? AND status = 'active' AND id != ? LIMIT 1`, m.content_hash, id).toArray()[0]?.id as string | undefined;
    if (twin) {
      if (m.supersedes && m.supersedes !== twin) this.markSuperseded(m.supersedes, twin, actor);
      this.sql.exec(`DELETE FROM memories WHERE id = ?`, id);
      this.audit("approve_merge", twin, actor, { proposal: id, supersedes: m.supersedes });
      await this.indexNow([id]); // also syncs m.supersedes, queued by markSuperseded
      return { ok: true, merged_into: twin };
    }
    const t = now();
    this.sql.exec(`UPDATE memories SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ?`, t, t, id);
    if (m.supersedes) this.markSuperseded(m.supersedes, id, actor);
    this.audit("approve", id, actor);
    await this.indexNow(m.supersedes ? [id, m.supersedes] : [id]);
    return { ok: true };
  }
  async reject(id: string, actor = "ui") {
    if (!this.get(id)) return { ok: false, error: "not found" };
    this.sql.exec(`UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ?`, now(), id);
    this.audit("reject", id, actor);
    await this.indexNow([id]); // removes its vector: rejected items never surface semantically
    return { ok: true };
  }
  async deleteMemory(id: string, actor = "ui") {
    if (!this.get(id)) return { ok: false, error: "not found" };
    this.sql.exec(`DELETE FROM memories WHERE id = ?`, id);
    this.audit("delete", id, actor);
    await this.indexNow([id]);
    return { ok: true };
  }
  async updateMemory(id: string, patch: { content?: string; type?: string }, actor = "ui") {
    const m = this.get(id);
    if (!m) return { ok: false, error: "not found" };
    const content = (patch.content ?? m.content).trim();
    if (!content) return { ok: false, error: "content is empty" };
    // Only new text is held to the length limit, so an older long memory can still change type.
    if (content !== m.content.trim() && content.length > MAX_CONTENT_LEN) return { ok: false, error: `content too long (max ${MAX_CONTENT_LEN} chars); split into separate memories` };
    if (looksLikeSecret(content)) return { ok: false, error: "Content looks like a secret; not saved." };
    const hash = await contentHash(content);
    if (hash !== m.content_hash) {
      if (this.isExcluded(hash)) return { ok: false, error: "That text matches a forgotten memory and can't be saved." };
      const dup = this.findByHash(hash);
      if (dup && dup.id !== id) return { ok: false, error: `Identical memory already exists (${dup.id}).`, duplicate_of: dup.id };
    }
    const type = isMemoryType(patch.type) ? patch.type : m.type;
    this.sql.exec(`UPDATE memories SET content = ?, type = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
      content, type, hash, now(), id);
    this.audit("update", id, actor, { type });
    this.labelArea(id, { reset: true });
    this.promoteAreas();
    await this.scheduleAlarm();
    // The stored embedding no longer matches content_hash, so it is treated as stale until re-embedded.
    return { ok: true, ...(await this.indexNow([id])) };
  }

  /**
   * Hard delete + content-free exclusion (sha256 of normalized content) so the
   * same text is never re-imported. By id, or by exact phrase (case-insensitive substring).
   * A phrase forgets at most FORGET_PAGE memories per call, oldest first, so a dry run previews exactly
   * what the next call deletes; `remaining` says how many more matches a further call would reach.
   */
  async forget(input: { id?: string; query?: string; dry_run?: boolean; actor?: string }) {
    const actor = input.actor ?? "agent";
    let targets: Memory[] = [];
    let total = 0;
    if (input.id) { const m = this.get(input.id); if (m) targets = [m]; total = targets.length; }
    else if (input.query && input.query.trim().length >= 3) {
      const q = input.query.trim();
      total = this.sql.exec(`SELECT COUNT(*) AS n FROM memories WHERE ${PHRASE_MATCH}`, q).one().n as number;
      targets = this.sql.exec(`SELECT ${COLS} FROM memories WHERE ${PHRASE_MATCH} ORDER BY created_at, id LIMIT ?`, q, FORGET_PAGE).toArray() as unknown as Memory[];
    } else return { ok: false, error: "provide id, or a query of at least 3 characters" };
    const remaining = total - targets.length;
    if (input.dry_run) return {
      ok: true, dry_run: true, total_matches: total, remaining_after: remaining,
      would_forget: targets.map((m) => ({ id: m.id, content: m.content, status: m.status })),
    };
    const t = now();
    for (const m of targets) {
      this.sql.exec(`DELETE FROM memories WHERE id = ?`, m.id);
      this.sql.exec(`INSERT INTO exclusions(id, pattern_hash, description, created_at) VALUES (?, ?, ?, ?)`,
        newId("excl"), m.content_hash, `forgotten ${m.type} (${input.id ? "by id" : "by phrase"})`, t);
      this.audit("forget", m.id, actor); // content-free on purpose
    }
    await this.indexNow(targets.map((m) => m.id));
    return { ok: true, forgotten: targets.length, remaining, ids: targets.map((m) => m.id) };
  }
  async listExclusions() {
    return this.sql.exec(`SELECT id, description, created_at FROM exclusions ORDER BY created_at DESC`).toArray();
  }

  // ---------- guide / settings ----------
  async getOperatingGuide() {
    return this.sql.exec(`SELECT content, version, updated_at FROM operating_guide WHERE id = 1`).one() as { content: string; version: number; updated_at: string };
  }
  async updateOperatingGuide(content: string, actor = "ui") {
    if (!content.trim()) return { ok: false, error: "guide cannot be empty" };
    if (content.length > MAX_GUIDE_LEN) return { ok: false, error: `guide too long (max ${MAX_GUIDE_LEN} chars)` };
    // Agents read the guide every session, so it must never carry a credential.
    if (looksLikeSecret(content)) return { ok: false, error: "Guide text looks like it contains a secret/credential; not saved." };
    const cur = await this.getOperatingGuide();
    const defaultHash = await sha256Hex(defaultGuide(this.env.OWNER_NAME));
    const version = cur.version + 1; const t = now();
    this.sql.exec(`UPDATE operating_guide SET content = ?, version = ?, updated_at = ? WHERE id = 1`, content, version, t);
    // Saving from the dashboard, where a newer default is pointed out, counts as having seen the current default.
    if (actor === "ui") this.sql.exec(`INSERT INTO settings(key, value) VALUES ('guide_default_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, defaultHash);
    this.sql.exec(`INSERT INTO guide_history(version, content, updated_at, actor) VALUES (?, ?, ?, ?)`, version, content, t, actor);
    this.audit("update_guide", null, actor, { version });
    return { ok: true, version };
  }
  /**
   * True when the deployed code ships a default guide that differs from the saved one and that the owner
   * hasn't seen yet (no dashboard save since it shipped). Agents mention it; the dashboard points to it.
   */
  async newerDefaultGuide(): Promise<boolean> {
    const defaultHash = await sha256Hex(defaultGuide(this.env.OWNER_NAME));
    if (await sha256Hex((await this.getOperatingGuide()).content) === defaultHash) return false;
    return this.sql.exec(`SELECT value FROM settings WHERE key = 'guide_default_seen'`).toArray()[0]?.value !== defaultHash;
  }
  async getApprovalMode() { return this.approvalMode(); }
  async guideHistory() {
    return this.sql.exec(`SELECT version, updated_at, actor, length(content) AS chars FROM guide_history ORDER BY version DESC`).toArray();
  }
  async getSettings() {
    const counts = Object.fromEntries(this.sql.exec(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).toArray().map((r) => [r.status, r.n]));
    const last = this.sql.exec(`SELECT value FROM settings WHERE key = 'last_cleanup'`).toArray()[0];
    return { approval_mode: this.approvalMode(), retention: this.retention(), last_cleanup: last ? JSON.parse(last.value as string) : null, counts, index: await this.indexStatus() };
  }
  private retention(): Retention {
    const out = { ...RETENTION_DEFAULTS };
    for (const r of this.sql.exec(`SELECT key, value FROM settings WHERE key LIKE 'retention_%'`)) {
      const k = (r.key as string).slice("retention_".length) as keyof Retention;
      const n = parseRetentionDays(r.value);
      if (k in out && n !== null) out[k] = n;
    }
    return out;
  }
  async setRetention(patch: Record<string, unknown>, actor = "ui") {
    const changed: Partial<Retention> = {};
    for (const k of RETENTION_KEYS) {
      if (patch[k] === undefined) continue;
      const n = parseRetentionDays(patch[k]);
      if (n === null) return { ok: false, error: `${k} must be a whole number of days from 0 to 3650 (0 = keep forever)` };
      changed[k] = n;
    }
    for (const [k, v] of Object.entries(changed))
      this.sql.exec(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, `retention_${k}`, String(v));
    if (Object.keys(changed).length) this.audit("set_retention", null, actor, changed);
    return { ok: true, retention: this.retention() };
  }

  /**
   * Remove history past its retention period: superseded memories, rejected memories (their content hash is kept
   * as an exclusion so the same text isn't re-imported, like forget), and old audit entries. Active and proposed
   * memories are never touched.
   */
  async cleanup(actor = "system", nowMs = Date.now()) {
    const ret = this.retention();
    const supCut = retentionCutoff(ret.superseded_days, nowMs);
    const rejCut = retentionCutoff(ret.rejected_days, nowMs);
    const audCut = retentionCutoff(ret.audit_days, nowMs);
    const t = now();
    const superseded = supCut ? this.sql.exec(`SELECT id FROM memories WHERE status = 'superseded' AND updated_at < ?`, supCut).toArray().map((r) => r.id as string) : [];
    const rejected = rejCut ? this.sql.exec(`SELECT id, type, content_hash FROM memories WHERE status = 'rejected' AND updated_at < ?`, rejCut).toArray() : [];
    // Same predicate as the SELECT above (no await in between), so this deletes exactly those rows.
    if (supCut) this.sql.exec(`DELETE FROM memories WHERE status = 'superseded' AND updated_at < ?`, supCut);
    for (const r of rejected) {
      this.sql.exec(`DELETE FROM memories WHERE id = ?`, r.id);
      if (!this.isExcluded(r.content_hash as string))
        this.sql.exec(`INSERT INTO exclusions(id, pattern_hash, description, created_at) VALUES (?, ?, ?, ?)`,
          newId("excl"), r.content_hash, `expired rejected ${r.type}`, t);
    }
    let audit = 0;
    if (audCut) {
      audit = this.sql.exec(`SELECT COUNT(*) AS n FROM audit WHERE timestamp < ?`, audCut).one().n as number;
      this.sql.exec(`DELETE FROM audit WHERE timestamp < ?`, audCut);
    }
    this.queueIndex(superseded); // rejected rows already have no vectors
    await this.syncIndex(superseded);
    const result = { at: t, superseded: superseded.length, rejected: rejected.length, audit };
    this.sql.exec(`INSERT INTO settings(key, value) VALUES ('last_cleanup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify(result));
    if (superseded.length || rejected.length || audit) this.audit("cleanup", null, actor, result);
    return { ok: true, ...result };
  }
  async setApprovalMode(mode: string, actor = "ui") {
    if (mode !== "review" && mode !== "auto") return { ok: false, error: "mode must be review or auto" };
    this.sql.exec(`INSERT INTO settings(key, value) VALUES ('approval_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, mode);
    this.audit("set_approval_mode", null, actor, { mode });
    return { ok: true, approval_mode: mode };
  }
  /** Remember that these OAuth grants are revoked, before the library deletes them from KV. Grant ids are never reused. */
  async recordRevokedGrants(grants: { grant_id: string; client_id?: string | null }[]) {
    const t = now();
    for (const g of grants)
      this.sql.exec(`INSERT OR IGNORE INTO revoked_grants(grant_id, client_id, revoked_at) VALUES (?, ?, ?)`, g.grant_id, g.client_id ?? null, t);
    return { ok: true };
  }
  async isGrantRevoked(grantId: string) {
    return this.sql.exec(`SELECT 1 FROM revoked_grants WHERE grant_id = ? LIMIT 1`, grantId).toArray().length > 0;
  }
  async revokedGrantIds() {
    return this.sql.exec(`SELECT grant_id FROM revoked_grants`).toArray().map((r) => r.grant_id as string);
  }
  /** Record an audit entry from the Worker (e.g. OAuth grant/revoke). Content-free details only. */
  async logAudit(action: string, actor: string, details?: unknown) {
    this.audit(action, null, actor, details);
    return { ok: true };
  }
  async recentAudit(limit = 50) {
    return this.sql.exec(`SELECT * FROM audit ORDER BY id DESC LIMIT ?`, limit).toArray();
  }

  async export(format: "md" | "json" = "md") {
    const guide = await this.getOperatingGuide();
    const memories = this.sql.exec(`SELECT ${COLS} FROM memories WHERE status != 'rejected' ORDER BY type, created_at`).toArray() as unknown as Memory[];
    if (format === "json") return JSON.stringify({ exported_at: now(), guide, settings: await this.getSettings(), memories }, null, 2);
    let md = `# frank-memory export (${now()})\n\n## Operating Guide (v${guide.version}, ${guide.updated_at})\n\n${guide.content}\n\n# Memories\n`;
    // Known types first, then any legacy ones still stored (e.g. "task" rows from before it was removed).
    for (const t of [...TYPE_ORDER, ...new Set(memories.map((m) => m.type).filter((x) => !TYPE_ORDER.includes(x)))]) {
      const group = memories.filter((m) => m.type === t);
      if (!group.length) continue;
      md += `\n## ${t}\n\n`;
      for (const m of group) {
        const meta = [m.status, m.area && `area: ${m.area}`, m.source && `source: ${m.source}`, m.source_date && `source date: ${m.source_date}`, `added: ${m.created_at}`, m.confirmed_at && `confirmed: ${m.confirmed_at}`, `id: ${m.id}`].filter(Boolean).join(" · ");
        md += `- ${m.content.replace(/\n/g, " ")}\n  <!-- ${meta} -->\n`;
      }
    }
    return md;
  }

  /**
   * Everything needed to rebuild this vault: all memories (rejected ones too, with ids, timestamps, lifecycle
   * links and embeddings), forget exclusions, import batches, the guide and its history, settings and the
   * audit log. Not included: OAuth grants (in KV; apps reconnect) and the Vectorize index (rebuilt on restore).
   */
  async backup(opts: { embeddings?: boolean } = {}): Promise<Backup> {
    const all = (q: string) => this.sql.exec(q).toArray() as any[];
    const withEmbeddings = opts.embeddings !== false;
    return {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now(), embed_model: EMBED_MODEL,
      guide: await this.getOperatingGuide(),
      guide_history: all(`SELECT version, content, updated_at, actor FROM guide_history ORDER BY id`),
      settings: Object.fromEntries(all(`SELECT key, value FROM settings`).filter((r) => !LOCAL_SETTINGS.includes(r.key)).map((r) => [r.key, r.value])),
      memories: all(`SELECT id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at, created_at, updated_at,
          similar_to, embedded_hash, embedding, area, area_source, area_hint FROM memories ORDER BY created_at, id`)
        .map((m) => ({ ...m, embedding: withEmbeddings && m.embedding ? bufferToBase64(m.embedding) : null })),
      exclusions: all(`SELECT id, pattern_hash, description, created_at FROM exclusions ORDER BY created_at, id`),
      batches: all(`SELECT id, source, added, created_at, undone_at FROM batches ORDER BY created_at, id`),
      audit: all(`SELECT action, memory_id, actor, details, timestamp FROM audit ORDER BY id`),
      areas: all(`SELECT name, aliases, description, embedding, created_by, created_at FROM areas ORDER BY name`)
        .map((a) => ({ ...a, aliases: JSON.parse(a.aliases), embedding: withEmbeddings && a.embedding ? bufferToBase64(a.embedding) : null })),
    };
  }

  /**
   * Restore a backup() into this vault, all or nothing. An empty vault is filled; a vault with memories,
   * exclusions or batches is only replaced when opts.replace is set. Content hashes are recomputed; an
   * embedding is kept only if it was made from the same content with the same model, otherwise the memory is
   * re-embedded. The search index is rebuilt afterwards through the index queue.
   */
  async restore(input: unknown, opts: { replace?: boolean } = {}, actor = "ui") {
    const parsed = parseBackup(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const b = parsed.backup;
    const sameModel = b.embed_model === EMBED_MODEL;
    const memories = await Promise.all(b.memories.map(async (m) => {
      const hash = await contentHash(m.content);
      const buf = sameModel && m.embedding && m.embedded_hash === hash && m.content_hash === hash ? base64ToBuffer(m.embedding) : null;
      return { ...m, content_hash: hash, embedding: buf?.byteLength === EMBED_DIMS * 4 ? buf : null };
    }));
    const count = (table: string) => this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n as number;
    if (!opts.replace && (count("memories") || count("exclusions") || count("batches")))
      return { ok: false, not_empty: true, error: "This vault already has memories. Restoring replaces everything in it; download a backup of it first, then restore with replace." };

    const previous = this.sql.exec(`SELECT id FROM memories`).toArray().map((r) => r.id as string);
    const reembed = memories.filter((m) => !m.embedding && m.status !== "rejected").length;
    const restored = { memories: memories.length, exclusions: b.exclusions.length, batches: b.batches.length, audit: b.audit.length, guide_version: b.guide.version };
    try {
      this.ctx.storage.transactionSync(() => {
        for (const table of ["memories", "exclusions", "batches", "guide_history", "audit", "index_jobs", "area_jobs", "areas"]) this.sql.exec(`DELETE FROM ${table}`);
        this.sql.exec(`DELETE FROM settings WHERE key NOT IN (${LOCAL_SETTINGS.map(() => "?").join(",")})`, ...LOCAL_SETTINGS);
        for (const m of memories)
          this.sql.exec(`INSERT INTO memories(id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at,
              created_at, updated_at, similar_to, embedding, embedded_hash, area, area_source, area_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            m.id, m.content, m.type, m.status, m.supersedes ?? null, m.source ?? null, m.content_hash, m.batch_id ?? null, m.source_date ?? null,
            m.confirmed_at ?? null, m.created_at, m.updated_at, m.similar_to ?? null, m.embedding, m.embedding ? m.content_hash : null,
            m.area ?? null, m.area_source ?? null, m.area_hint ?? null);
        for (const a of b.areas ?? []) {
          const emb = sameModel && a.embedding ? base64ToBuffer(a.embedding) : null;
          this.sql.exec(`INSERT INTO areas(name, aliases, description, embedding, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            a.name, JSON.stringify(a.aliases), a.description, emb?.byteLength === EMBED_DIMS * 4 ? emb : null, a.created_by, a.created_at);
        }
        for (const e of b.exclusions)
          this.sql.exec(`INSERT INTO exclusions(id, pattern_hash, description, created_at) VALUES (?, ?, ?, ?)`, e.id, e.pattern_hash, e.description ?? null, e.created_at);
        for (const x of b.batches)
          this.sql.exec(`INSERT INTO batches(id, source, added, created_at, undone_at) VALUES (?, ?, ?, ?, ?)`, x.id, x.source ?? null, x.added, x.created_at, x.undone_at ?? null);
        for (const g of b.guide_history)
          this.sql.exec(`INSERT INTO guide_history(version, content, updated_at, actor) VALUES (?, ?, ?, ?)`, g.version, g.content, g.updated_at, g.actor ?? null);
        this.sql.exec(`UPDATE operating_guide SET content = ?, version = ?, updated_at = ? WHERE id = 1`, b.guide.content, b.guide.version, b.guide.updated_at);
        for (const [k, v] of Object.entries(b.settings))
          if (!LOCAL_SETTINGS.includes(k)) this.sql.exec(`INSERT INTO settings(key, value) VALUES (?, ?)`, k, v);
        this.sql.exec(`INSERT OR IGNORE INTO settings(key, value) VALUES ('approval_mode', 'review')`);
        for (const a of b.audit)
          this.sql.exec(`INSERT INTO audit(action, memory_id, actor, details, timestamp) VALUES (?, ?, ?, ?, ?)`, a.action, a.memory_id ?? null, a.actor ?? null, a.details ?? null, a.timestamp);
        // Vectors of the replaced memories are removed and the restored ones indexed (rejected ones get no vector).
        this.queueIndex([...previous, ...memories.map((m) => m.id)]);
        this.audit("restore", null, actor, { from: b.exported_at, replaced: previous.length, ...restored, reembed });
        // Restored labels are kept (owner, agent and model choices stick); a backup from before areas is labeled afresh.
        for (const a of this.areaDefs()) this.refreshAreaTerms(a.name);
        this.relabelAreas("restore");
      });
    } catch (e) {
      // The transaction rolled back, so the vault is exactly as it was.
      return { ok: false, error: `restore failed and nothing was changed: ${(e as Error).message}` };
    }
    await this.scheduleAlarm();
    return { ok: true, from: b.exported_at, replaced: previous.length, restored, reembed, note: "The search index is rebuilding in the background; keyword search works meanwhile." };
  }

  /** Retries due index jobs, runs the daily history cleanup when it's due, then schedules the next alarm. */
  async alarm() {
    try {
      await this.syncIndex();
      await this.labelAreasInBackground();
      if (Date.now() >= this.nextCleanupAt()) {
        this.sql.exec(`UPDATE settings SET value = ? WHERE key = 'next_cleanup_at'`, String(Date.now() + CLEANUP_EVERY_MS));
        await this.cleanup();
      }
    } finally { await this.scheduleAlarm(); }
  }

  /**
   * Queue every live memory for indexing, so Vectorize is rebuilt from SQLite (the source of truth).
   * With reembed, embeddings are recomputed too (e.g. after an embedding-model change). The alarm works
   * through the queue in batches; recall keeps using stored embeddings meanwhile.
   */
  async rebuildIndex(opts: { reembed?: boolean } = {}, actor = "ui") {
    const ids = this.sql.exec(`SELECT id FROM memories WHERE status != 'rejected'`).toArray().map((r) => r.id as string);
    this.queueIndex(ids, !!opts.reembed);
    this.audit("rebuild_index", null, actor, { queued: ids.length, reembed: !!opts.reembed });
    await this.scheduleAlarm();
    return { ok: true, queued: ids.length };
  }
  /** Index backlog, for the dashboard. */
  async indexStatus() {
    const r = this.sql.exec(`SELECT COUNT(*) AS pending, SUM(attempts > 0) AS failing, MIN(next_at) AS next_retry FROM index_jobs`).one();
    const last = this.sql.exec(`SELECT last_error FROM index_jobs WHERE last_error IS NOT NULL ORDER BY next_at DESC LIMIT 1`).toArray()[0];
    return { pending: Number(r.pending), failing: Number(r.failing ?? 0), next_retry: r.pending ? r.next_retry : null, last_error: last?.last_error ?? null };
  }
}

export { isMemoryStatus };
