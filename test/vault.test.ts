import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TIMEOUT_MS, MAX_IMPORT_ITEMS, MAX_IMPORT_TEXT, VECTORIZE_TIMEOUT_MS } from "../src/helpers";
import { createVault, vectorNear } from "./support/vault-harness";

const OLD = "2020-01-01T00:00:00.000Z";

describe("bulkRemember vs forget (review #2)", () => {
  it("does not bring back text forgotten while the import waited for embeddings", async () => {
    const h = createVault({ approvalMode: "auto" });
    const text = "Sam's sister lives in Lisbon";
    const paused = h.pauseNextEmbed();
    const importing = h.vault.bulkRemember({ items: [{ content: text }] });
    await paused.reached;

    const saved = await h.vault.remember({ content: text, actor: "ui", status: "active" });
    await h.vault.forget({ id: saved.id });
    paused.release();

    const res = await importing;
    expect(res).toMatchObject({ added: 0, excluded: 1 });
    expect(h.rows("content = ?", text)).toEqual([]);
  });

  it("does not insert a duplicate saved while the import waited", async () => {
    const h = createVault({ approvalMode: "auto" });
    const text = "Sam takes the 7:40 train";
    const paused = h.pauseNextEmbed();
    const importing = h.vault.bulkRemember({ items: [{ content: text }] });
    await paused.reached;
    await h.vault.remember({ content: text, actor: "ui", status: "active" });
    paused.release();

    const res = await importing;
    expect(res).toMatchObject({ added: 0, duplicates: 1 });
    expect(h.rows("content = ?", text)).toHaveLength(1);
  });
});

describe("undoBatch (review #6)", () => {
  async function importReplacement() {
    const h = createVault({ approvalMode: "review" });
    const oldText = "Sam's dentist is Dr. Ortiz";
    const newText = "Sam switched dentists to Dr. Patel";
    h.embedAs(newText, vectorNear(h.embeddingOf(oldText), 0.85));
    const a = await h.vault.remember({ content: oldText, actor: "ui", status: "active" });
    const imp = await h.vault.bulkRemember({ items: [{ content: newText }] });
    const b = h.rows("content = ?", newText)[0];
    expect(b.similar_to).toBe(a.id);
    expect((await h.vault.approve(b.id, "ui", { supersedeSimilar: true })).ok).toBe(true);
    expect(h.rows("id = ?", a.id)[0].status).toBe("superseded");
    return { h, aId: a.id as string, batchId: (imp as { batch_id: string }).batch_id };
  }

  it("restores the memory an approved import replaced", async () => {
    const { h, aId, batchId } = await importReplacement();
    const res = await h.vault.undoBatch(batchId);
    expect(res.restored).toBe(1);
    expect(h.rows("id = ?", aId)[0].status).toBe("active");
  });

  it("leaves the predecessor alone when something outside the batch also replaced it", async () => {
    const { h, aId, batchId } = await importReplacement();
    await h.vault.remember({ content: "Sam's dentist moved offices", actor: "ui", status: "active", supersedes: aId });
    const res = await h.vault.undoBatch(batchId);
    expect(res.restored).toBe(0);
    expect(h.rows("id = ?", aId)[0].status).toBe("superseded");
  });
});

describe("recall eligibility (review #7)", () => {
  it("finds an active keyword match behind 20+ stronger superseded ones", async () => {
    const h = createVault();
    for (let i = 0; i < 25; i++) await h.vault.remember({ content: `zebra zebra zebra ${i}`, actor: "ui", status: "active" });
    h.db.prepare(`UPDATE memories SET status = 'superseded'`).run();
    const active = await h.vault.remember({ content: "the zebra exhibit opens in May, according to the zoo newsletter", actor: "ui", status: "active" });

    const res = await h.vault.recall({ query: "zebra" });
    expect(res.results.map((r) => r.id)).toEqual([active.id]);
  });

  it("finds an active semantic match behind 20+ closer superseded ones", async () => {
    const h = createVault();
    const query = "where does Sam keep the spare key";
    const q = h.embeddingOf(query);
    for (let i = 0; i < 25; i++) {
      const text = `old note ${i}`;
      h.embedAs(text, vectorNear(q, 0.95, `s${i}`));
      await h.vault.remember({ content: text, actor: "ui", status: "active" });
    }
    h.db.prepare(`UPDATE memories SET status = 'superseded'`).run();
    const current = "under the blue flowerpot";
    h.embedAs(current, vectorNear(q, 0.8, "current"));
    const active = await h.vault.remember({ content: current, actor: "ui", status: "active" });

    const res = await h.vault.recall({ query });
    expect(res.results.map((r) => r.id)).toEqual([active.id]);
  });

  it("applies the type filter before the candidate cut-off", async () => {
    const h = createVault();
    for (let i = 0; i < 25; i++) await h.vault.remember({ content: `falcon falcon falcon ${i}`, type: "note", actor: "ui", status: "active" });
    const pref = await h.vault.remember({ content: "Sam prefers the falcon logo in dark blue over every other option we tried", type: "preference", actor: "ui", status: "active" });

    const res = await h.vault.recall({ query: "falcon", type: "preference" });
    expect(res.results.map((r) => r.id)).toEqual([pref.id]);
  });
});

describe("forget by phrase (review #9, #10)", () => {
  it("reports the total and deletes in bounded, previewed steps", async () => {
    const h = createVault();
    for (let i = 0; i < 60; i++) await h.vault.remember({ content: `Project Falcon detail number ${i}`, actor: "ui", status: "active" });

    const preview = await h.vault.forget({ query: "project falcon", dry_run: true });
    expect(preview.total_matches).toBe(60);
    expect(preview.would_forget).toHaveLength(50);
    expect(preview.remaining_after).toBe(10);

    const first = await h.vault.forget({ query: "project falcon" });
    expect(first.forgotten).toBe(50);
    expect(first.remaining).toBe(10);
    expect(first.ids).toEqual(preview.would_forget!.map((m) => m.id));

    const second = await h.vault.forget({ query: "project falcon" });
    expect(second.forgotten).toBe(10);
    expect(second.remaining).toBe(0);
    expect(h.rows()).toEqual([]);
  });

  it("accepts a full-sentence phrase longer than the LIKE pattern limit", async () => {
    const h = createVault();
    const sentence = "Sam's old apartment on Fulton Street had a leaky radiator in the bedroom";
    await h.vault.remember({ content: `${sentence}.`, actor: "ui", status: "active" });
    const res = await h.vault.forget({ query: sentence });
    expect(res.forgotten).toBe(1);
  });

  it("lists by a long phrase too", async () => {
    const h = createVault();
    const sentence = "Sam's old apartment on Fulton Street had a leaky radiator in the bedroom";
    await h.vault.remember({ content: sentence, actor: "ui", status: "active" });
    expect((await h.vault.listMemories({ q: sentence.toUpperCase() })).total).toBe(1);
  });

  it("treats % and _ in the phrase literally", async () => {
    const h = createVault();
    await h.vault.remember({ content: "growth was 50% this year", actor: "ui", status: "active" });
    await h.vault.remember({ content: "growth was 50 this year", actor: "ui", status: "active" });
    expect((await h.vault.listMemories({ q: "50%" })).total).toBe(1);
  });
});

describe("cleanup (review #10)", () => {
  it("deletes more expired superseded memories than the bound-parameter limit", async () => {
    const h = createVault();
    for (let i = 0; i < 150; i++) await h.vault.remember({ content: `history ${i}`, actor: "ui", status: "active" });
    h.db.prepare(`UPDATE memories SET status = 'superseded', updated_at = ?`).run(OLD);
    const keep = await h.vault.remember({ content: "still current", actor: "ui", status: "active" });

    const res = await h.vault.cleanup();
    expect(res.superseded).toBe(150);
    expect(h.rows().map((r) => r.id)).toEqual([keep.id]);
    expect([...h.vectors.keys()]).toEqual([keep.id]);
  });
});

describe("supersede with wording that already exists (review #8)", () => {
  const A = "Sam's standup is at 9:30";
  const B = "Sam's standup is at 10:00";

  it("auto mode: applies the replacement to the existing memory", async () => {
    const h = createVault({ approvalMode: "auto" });
    const a = await h.vault.remember({ content: A });
    const b = await h.vault.remember({ content: B });
    const res = await h.vault.remember({ content: A, supersedes: b.id });
    expect(res).toMatchObject({ ok: true, duplicate: true, id: a.id, supersedes: b.id });
    expect(h.rows("id = ?", b.id)[0].status).toBe("superseded");
    expect(h.rows("id = ?", a.id)[0].status).toBe("active");
  });

  it("review mode: waits for approval, then merges into the existing memory", async () => {
    const h = createVault({ approvalMode: "review" });
    const a = await h.vault.remember({ content: A, actor: "ui", status: "active" });
    const b = await h.vault.remember({ content: B, actor: "ui", status: "active" });
    const res = await h.vault.remember({ content: A, supersedes: b.id });
    expect(res).toMatchObject({ ok: true, status: "proposed", supersedes: b.id });
    expect(h.rows("id = ?", b.id)[0].status).toBe("active");

    expect(await h.vault.approve(res.id as string)).toMatchObject({ ok: true, merged_into: a.id });
    expect(h.rows("id = ?", b.id)[0].status).toBe("superseded");
    expect(h.rows("content = ?", A)).toEqual([expect.objectContaining({ id: a.id, status: "active" })]);
  });

  it("propose_memory never applies the replacement right away", async () => {
    const h = createVault({ approvalMode: "auto" });
    await h.vault.remember({ content: A });
    const b = await h.vault.remember({ content: B });
    const res = await h.vault.remember({ content: A, supersedes: b.id, status: "proposed" });
    expect(res.status).toBe("proposed");
    expect(h.rows("id = ?", b.id)[0].status).toBe("active");
  });

  it("links the replacement to an identical pending proposal", async () => {
    const h = createVault({ approvalMode: "review" });
    const b = await h.vault.remember({ content: B, actor: "ui", status: "active" });
    const a = await h.vault.remember({ content: A });
    const res = await h.vault.remember({ content: A, supersedes: b.id });
    expect(res).toMatchObject({ duplicate: true, id: a.id, status: "proposed", supersedes: b.id });
    await h.vault.approve(a.id as string);
    expect(h.rows("id = ?", b.id)[0].status).toBe("superseded");
  });

  it("restating superseded wording makes it current again (auto mode)", async () => {
    const h = createVault({ approvalMode: "auto" });
    const a = await h.vault.remember({ content: A });
    const b = await h.vault.remember({ content: B, supersedes: a.id });
    expect(h.rows("id = ?", a.id)[0].status).toBe("superseded");

    const res = await h.vault.remember({ content: A });
    expect(res).toMatchObject({ ok: true, status: "active", supersedes: b.id });
    expect(res.id).not.toBe(a.id);
    expect(h.rows("id = ?", b.id)[0].status).toBe("superseded");
    expect((await h.vault.recall({ query: "standup" })).results.map((r) => r.id)).toEqual([res.id]);
  });

  it("restating superseded wording follows the replacement chain and needs approval in review mode", async () => {
    const h = createVault({ approvalMode: "review" });
    const a = await h.vault.remember({ content: A, actor: "ui", status: "active" });
    const b = await h.vault.remember({ content: B, actor: "ui", status: "active", supersedes: a.id });
    const c = await h.vault.remember({ content: "Sam's standup is at 10:15", actor: "ui", status: "active", supersedes: b.id });

    const res = await h.vault.remember({ content: A });
    expect(res).toMatchObject({ status: "proposed", supersedes: c.id });
    expect(h.rows("id = ?", c.id)[0].status).toBe("active");
    await h.vault.approve(res.id as string);
    expect(h.rows("id = ?", c.id)[0].status).toBe("superseded");
    expect(h.rows("id = ?", res.id)[0].status).toBe("active");
  });

  it("a plain repeat of current wording is still a no-op", async () => {
    const h = createVault({ approvalMode: "auto" });
    const a = await h.vault.remember({ content: A });
    expect(await h.vault.remember({ content: A })).toMatchObject({ duplicate: true, id: a.id });
    expect(h.rows()).toHaveLength(1);
  });
});

describe("secret and length checks on every stored field (review #14)", () => {
  const KEY = "sk-proj-abcdefghijklmnopqrstuvwx";

  it("rejects a remember whose source looks like a secret", async () => {
    const h = createVault();
    const res = await h.vault.remember({ content: "Sam uses Linear", source: `script ${KEY}` });
    expect(res).toMatchObject({ ok: false, status: "rejected" });
    expect(h.rows()).toEqual([]);
  });

  it("rejects over-long source and source_date", async () => {
    const h = createVault();
    expect((await h.vault.remember({ content: "x is y", source: "s".repeat(301) })).ok).toBe(false);
    expect((await h.vault.remember({ content: "x is y", source_date: "d".repeat(41) })).ok).toBe(false);
  });

  it("skips import items with secret or over-long metadata, and rejects a secret batch source", async () => {
    const h = createVault();
    const res = await h.vault.bulkRemember({ items: [
      { content: "Sam likes tea", source: `token: ${KEY}` },
      { content: "Sam likes jazz", source_date: "d".repeat(41) },
      { content: "Sam likes chess" },
    ] });
    expect(res).toMatchObject({ added: 1, secrets_skipped: 1, invalid: 1 });
    expect((await h.vault.bulkRemember({ items: ["Sam likes tea"], source: `bearer ${KEY}` })).ok).toBe(false);
  });

  it("rejects guide text with a secret or over the length limit, but accepts the default guide", async () => {
    const h = createVault();
    const { content } = await h.vault.getOperatingGuide();
    expect((await h.vault.updateOperatingGuide(`${content}\nAPI key: ${KEY}`)).ok).toBe(false);
    expect((await h.vault.updateOperatingGuide("g".repeat(50_001))).ok).toBe(false);
    expect((await h.vault.updateOperatingGuide(`${content}\n`)).ok).toBe(true);
  });
});

describe("search index stays in sync (review #4)", () => {
  it("an edit during an AI outage doesn't keep searching by the old meaning, and is indexed once AI is back", async () => {
    const h = createVault({ approvalMode: "auto" });
    const oldText = "Sam's gym is Crunch on 5th Ave";
    const newText = "Sam cancelled the gym and runs in the park";
    const m = await h.vault.remember({ content: oldText });

    h.state.aiDown = true;
    const res = await h.vault.updateMemory(m.id as string, { content: newText });
    expect(res).toMatchObject({ ok: true, index_pending: 1 });
    expect(h.jobs()).toEqual([expect.objectContaining({ memory_id: m.id, attempts: 1, last_error: "embedding unavailable" })]);
    expect(h.state.alarmAt).not.toBeNull();

    // Vectorize still holds the old vector; it must not make the memory match the old meaning.
    h.state.aiDown = false;
    h.embedAs("crunch membership", h.embeddingOf(oldText));
    expect((await h.vault.recall({ query: "crunch membership" })).results).toEqual([]);

    h.makeJobsDue();
    await h.vault.alarm();
    expect(h.jobs()).toEqual([]);
    expect(h.vectors.get(m.id as string)).toEqual(h.embeddingOf(newText));
    h.embedAs("where does Sam exercise", h.embeddingOf(newText));
    expect((await h.vault.recall({ query: "where does Sam exercise" })).results.map((r) => r.id)).toEqual([m.id]);
  });

  it("a slow embedding for older content can't overwrite a newer edit", async () => {
    const h = createVault({ approvalMode: "auto" });
    const first = "Sam's team is Platform";
    const second = "Sam moved to the Payments team";
    const paused = h.pauseNextEmbed();
    const saving = h.vault.remember({ content: first });
    await paused.reached;
    const id = h.rows("content = ?", first)[0].id;
    await h.vault.updateMemory(id, { content: second });
    paused.release();
    await saving;

    // The first write's embedding was for content that no longer exists, so it wasn't stored...
    expect(h.db.prepare(`SELECT coalesce(embedded_hash = content_hash, 0) AS current FROM memories WHERE id = ?`).get(id)).toMatchObject({ current: 0 });
    // ...and the job is still queued, so the alarm puts the right vector in place.
    expect(h.jobs().map((j) => j.memory_id)).toEqual([id]);
    await h.vault.alarm();
    expect(h.vectors.get(id)).toEqual(h.embeddingOf(second));
    expect(h.jobs()).toEqual([]);
  });

  it("retries failed Vectorize writes and deletes from the queue", async () => {
    const h = createVault({ approvalMode: "auto" });
    const keep = await h.vault.remember({ content: "Sam's cat is called Miso" });
    const gone = await h.vault.remember({ content: "Sam's old landline number is retired" });

    h.state.vectorizeDown = true;
    const added = await h.vault.remember({ content: "Sam's dog is called Tofu" });
    await h.vault.forget({ id: gone.id as string });
    expect(added).toMatchObject({ index_pending: 1 });
    expect(h.vectors.has(added.id as string)).toBe(false);
    expect(h.vectors.has(gone.id as string)).toBe(true);
    expect((await h.vault.getSettings()).index).toMatchObject({ pending: 2, failing: 2 });

    h.state.vectorizeDown = false;
    await h.vault.alarm(); // not due yet: backoff
    expect(h.jobs()).toHaveLength(2);
    h.makeJobsDue();
    await h.vault.alarm();
    expect(h.jobs()).toEqual([]);
    expect([...h.vectors.keys()].sort()).toEqual([keep.id, added.id].sort());
  });

  it("status changes reuse the stored embedding instead of calling AI again", async () => {
    const h = createVault({ approvalMode: "review" });
    const m = await h.vault.remember({ content: "Sam prefers aisle seats" });
    const calls = h.state.aiCalls;
    await h.vault.approve(m.id as string);
    await h.vault.reject(m.id as string);
    expect(h.state.aiCalls).toBe(calls);
    expect(h.vectors.has(m.id as string)).toBe(false);
  });

  it("rebuildIndex restores a wiped Vectorize from SQLite without re-embedding", async () => {
    const h = createVault({ approvalMode: "auto" });
    for (let i = 0; i < 3; i++) await h.vault.remember({ content: `Sam fact number ${i}` });
    const ids = h.rows().map((r) => r.id).sort();
    h.vectors.clear();
    const calls = h.state.aiCalls;

    expect(await h.vault.rebuildIndex()).toMatchObject({ ok: true, queued: 3 });
    await h.vault.alarm();
    expect([...h.vectors.keys()].sort()).toEqual(ids);
    expect(h.state.aiCalls).toBe(calls);

    await h.vault.rebuildIndex({ reembed: true });
    await h.vault.alarm();
    expect(h.state.aiCalls).toBeGreaterThan(calls);
  });

  it("runs the daily cleanup only when it's due", async () => {
    const h = createVault();
    const m = await h.vault.remember({ content: "old history", actor: "ui", status: "active" });
    h.db.prepare(`UPDATE memories SET status = 'superseded', updated_at = '2020-01-01T00:00:00.000Z'`).run();
    h.db.prepare(`UPDATE settings SET value = ? WHERE key = 'next_cleanup_at'`).run(String(Date.now() + 3_600_000));
    await h.vault.alarm();
    expect(h.rows("id = ?", m.id)).toHaveLength(1);

    h.db.prepare(`UPDATE settings SET value = '0' WHERE key = 'next_cleanup_at'`).run();
    await h.vault.alarm();
    expect(h.rows("id = ?", m.id)).toEqual([]);
    expect(Number((h.db.prepare(`SELECT value FROM settings WHERE key = 'next_cleanup_at'`).get() as any).value)).toBeGreaterThan(Date.now());
  });
});

describe("v4 migration on an existing vault", () => {
  it("trusts existing embeddings and queues rows that never got one", async () => {
    const old = createVault({ approvalMode: "auto" });
    const embedded = await old.vault.remember({ content: "Sam lives in Denver" });
    old.state.aiDown = true;
    const missing = await old.vault.remember({ content: "Sam's partner is Alex" });
    // Turn the database back into its pre-v4 shape.
    old.db.exec(`DROP TABLE index_jobs; ALTER TABLE memories DROP COLUMN embedded_hash;`);

    const h = createVault({ db: old.db });
    expect(h.db.prepare(`SELECT id, embedded_hash = content_hash AS current FROM memories ORDER BY id`).all())
      .toEqual(expect.arrayContaining([{ id: embedded.id, current: 1 }, { id: missing.id, current: null }]));
    expect(h.jobs().map((j) => j.memory_id)).toEqual([missing.id]);
    await h.vault.alarm();
    expect(h.vectors.has(missing.id as string)).toBe(true);
    expect(h.jobs()).toEqual([]);
  });
});

describe("full backup and restore (review #5)", () => {
  /** A vault with history in it: replacements, an import that replaced something, a forget, a rejection, guide versions. */
  async function richVault() {
    const h = createVault({ approvalMode: "review" });
    const oldDentist = "Sam's dentist is Dr. Ortiz";
    const newDentist = "Sam switched dentists to Dr. Patel";
    h.embedAs(newDentist, vectorNear(h.embeddingOf(oldDentist), 0.85));
    const a = await h.vault.remember({ content: oldDentist, actor: "ui", status: "active" });
    const imp = await h.vault.bulkRemember({ items: [{ content: newDentist, source_date: "2026-09-01" }, "Sam drinks oolong"] });
    const b = h.rows("content = ?", newDentist)[0];
    await h.vault.approve(b.id, "ui", { supersedeSimilar: true });
    const x = await h.vault.remember({ content: "Sam's locker code is in 1Password" });
    await h.vault.reject(x.id as string);
    const gone = await h.vault.remember({ content: "Sam's ex lives on Elm St", actor: "ui", status: "active" });
    await h.vault.forget({ id: gone.id as string });
    await h.vault.updateOperatingGuide("# Custom guide\nBe brief.");
    await h.vault.setRetention({ superseded_days: 90 });
    await h.vault.setApprovalMode("auto");
    return { h, aId: a.id as string, bId: b.id as string, batchId: (imp as { batch_id: string }).batch_id, rejectedText: "Sam's locker code is in 1Password", forgottenText: "Sam's ex lives on Elm St" };
  }
  const dump = (h: ReturnType<typeof createVault>) => ({
    memories: h.db.prepare(`SELECT id, content, type, status, supersedes, source, content_hash, batch_id, source_date, confirmed_at, created_at, updated_at, similar_to FROM memories ORDER BY id`).all(),
    exclusions: h.db.prepare(`SELECT id, pattern_hash, description, created_at FROM exclusions ORDER BY id`).all(),
    batches: h.db.prepare(`SELECT * FROM batches ORDER BY id`).all(),
    guide: h.db.prepare(`SELECT content, version, updated_at FROM operating_guide`).all(),
    guide_history: h.db.prepare(`SELECT version, content, updated_at, actor FROM guide_history ORDER BY id`).all(),
    settings: h.db.prepare(`SELECT key, value FROM settings WHERE key != 'next_cleanup_at' ORDER BY key`).all(),
  });

  it("round-trips every table, keeps ids and lifecycle, and rebuilds the index without re-embedding", async () => {
    const src = await richVault();
    const file = JSON.parse(JSON.stringify(await src.h.vault.backup()));
    const auditBefore = (src.h.db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as any).n;

    const dst = createVault();
    const res = await dst.vault.restore(file);
    expect(res).toMatchObject({ ok: true, replaced: 0, reembed: 0 });
    expect(dump(dst)).toEqual(dump(src.h));
    expect((dst.db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as any).n).toBe(auditBefore + 1);

    const calls = dst.state.aiCalls;
    await dst.vault.alarm();
    expect(dst.state.aiCalls).toBe(calls);
    const live = dst.rows("status != 'rejected'").map((r) => r.id).sort();
    expect([...dst.vectors.keys()].sort()).toEqual(live);

    // The restored vault behaves like the original.
    expect((await dst.vault.remember({ content: src.forgottenText })).status).toBe("excluded");
    expect((await dst.vault.undoBatch(src.batchId)).restored).toBe(1);
    expect(dst.rows("id = ?", src.aId)[0].status).toBe("active");
  });

  it("refuses to restore over a vault with memories unless told to replace it", async () => {
    const src = await richVault();
    const file = JSON.parse(JSON.stringify(await src.h.vault.backup()));
    const dst = createVault({ approvalMode: "auto" });
    const mine = await dst.vault.remember({ content: "something only in the target vault" });

    expect(await dst.vault.restore(file)).toMatchObject({ ok: false, not_empty: true });
    expect(dst.rows("id = ?", mine.id)).toHaveLength(1);

    expect(await dst.vault.restore(file, { replace: true })).toMatchObject({ ok: true, replaced: 1 });
    expect(dst.rows("id = ?", mine.id)).toEqual([]);
    expect(dump(dst)).toEqual(dump(src.h));
    await dst.vault.alarm();
    expect(dst.vectors.has(mine.id as string)).toBe(false);
  });

  it("re-embeds memories whose embedding is missing, for other content, or from another model", async () => {
    const src = await richVault();
    const file = JSON.parse(JSON.stringify(await src.h.vault.backup()));
    const live = file.memories.filter((m: any) => m.status !== "rejected");
    live[0].content += " (edited by hand)";
    live[1].embedding = null;

    const dst = createVault();
    expect(await dst.vault.restore(file)).toMatchObject({ ok: true, reembed: 2 });
    expect(dst.rows("id = ?", live[0].id)[0].content).toMatch(/edited by hand/);

    const other = createVault();
    expect(await other.vault.restore({ ...JSON.parse(JSON.stringify(await src.h.vault.backup())), embed_model: "@cf/other/model" }))
      .toMatchObject({ ok: true, reembed: live.length });
  });

  it("backs up without embeddings on request, and that still restores", async () => {
    const src = await richVault();
    const file = JSON.parse(JSON.stringify(await src.h.vault.backup({ embeddings: false })));
    expect(file.memories.every((m: any) => m.embedding === null)).toBe(true);
    const dst = createVault();
    expect(await dst.vault.restore(file)).toMatchObject({ ok: true });
    await dst.vault.alarm();
    expect(dst.vectors.size).toBe(dst.rows("status != 'rejected'").length);
  });

  it("rejects malformed backups and rolls back a restore that fails part-way", async () => {
    const src = await richVault();
    const good = JSON.parse(JSON.stringify(await src.h.vault.backup()));
    const dst = createVault({ approvalMode: "auto" });

    expect(await dst.vault.restore({ format: "something-else" })).toMatchObject({ ok: false });
    expect(await dst.vault.restore({ ...good, version: 99 })).toMatchObject({ ok: false, error: expect.stringMatching(/version 99/) });
    expect(await dst.vault.restore({ ...good, memories: [{ ...good.memories[0], status: "deleted" }] })).toMatchObject({ ok: false, error: "memories[0] is malformed" });
    expect(await dst.vault.restore({ ...good, memories: [good.memories[0], good.memories[0]] })).toMatchObject({ ok: false, error: expect.stringMatching(/duplicate memory id/) });

    const mine = await dst.vault.remember({ content: "kept when a restore fails" });
    const before = dump(dst);
    const broken = { ...good, exclusions: [...good.exclusions, good.exclusions[0]] }; // primary-key clash mid-transaction
    expect(await dst.vault.restore(broken, { replace: true })).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was changed/) });
    expect(dump(dst)).toEqual(before);
    expect(dst.rows("id = ?", mine.id)).toHaveLength(1);
  });
});

describe("import limits (review #12)", () => {
  it("refuses more than the item limit, from items or from split text, and stores nothing", async () => {
    const h = createVault({ approvalMode: "auto" });
    const many = Array.from({ length: MAX_IMPORT_ITEMS + 1 }, (_, i) => `Sam fact number ${i}`);
    expect(await h.vault.bulkRemember({ items: many.map((content) => ({ content })) })).toMatchObject({ ok: false, error: expect.stringContaining("too many items") });
    expect(await h.vault.bulkRemember({ text: many.join("\n---\n") })).toMatchObject({ ok: false, error: expect.stringContaining("too many items") });
    expect(h.rows()).toHaveLength(0);
  });

  it("refuses text over the character limit", async () => {
    const h = createVault({ approvalMode: "auto" });
    expect(await h.vault.bulkRemember({ text: "x".repeat(MAX_IMPORT_TEXT + 1) })).toMatchObject({ ok: false, error: expect.stringContaining("text too long") });
  });

  it("accepts an import at the item limit", async () => {
    const h = createVault({ approvalMode: "auto" });
    const items = Array.from({ length: MAX_IMPORT_ITEMS }, (_, i) => ({ content: `Sam fact number ${i}` }));
    expect(await h.vault.bulkRemember({ items })).toMatchObject({ ok: true });
  });
});

describe("time limits on Workers AI and Vectorize (review #13)", () => {
  afterEach(() => { vi.useRealTimers(); });
  /** Let real async work (hashing) run until `ready()`, then jump the fake clock past the time limit. */
  async function expire(ready: () => boolean, ms: number) {
    while (!ready()) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("recall falls back to keyword search when embedding hangs", async () => {
    const h = createVault({ approvalMode: "auto" });
    await h.vault.remember({ content: "Sam's favourite tea is genmaicha" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.state.aiHang = true;
    const calls = h.state.aiCalls;
    const p = h.vault.recall({ query: "genmaicha" });
    await expire(() => h.state.aiCalls > calls, AI_TIMEOUT_MS);
    expect(await p).toMatchObject({ mode: "keyword-only", results: [expect.objectContaining({ content: "Sam's favourite tea is genmaicha" })] });
  });

  it("recall still answers when a Vectorize query hangs", async () => {
    const h = createVault({ approvalMode: "auto" });
    await h.vault.remember({ content: "Sam's favourite tea is genmaicha" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.state.vectorizeHang = true;
    const p = h.vault.recall({ query: "genmaicha" });
    await vi.advanceTimersByTimeAsync(VECTORIZE_TIMEOUT_MS);
    expect(await p).toMatchObject({ mode: "keyword-only", results: [expect.objectContaining({ content: "Sam's favourite tea is genmaicha" })] });
  });

  it("a hung embedding during a save leaves the memory queued for indexing", async () => {
    const h = createVault({ approvalMode: "auto" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.state.aiHang = true;
    const p = h.vault.remember({ content: "Sam's partner is Alex" });
    await expire(() => h.state.aiCalls > 0, AI_TIMEOUT_MS);
    expect(await p).toMatchObject({ ok: true, status: "active" });
    expect(h.jobs()).toEqual([expect.objectContaining({ attempts: 1, last_error: "embedding unavailable" })]);
  });
});

describe("newer default guide notice", () => {
  it("is off for a vault on the shipped default, on for an older saved guide, and off again after a dashboard save", async () => {
    const h = createVault();
    expect(await h.vault.newerDefaultGuide()).toBe(false);

    // A vault whose guide was saved before the code shipped a new default.
    h.db.prepare(`UPDATE operating_guide SET content = ?`).run("# Older default guide");
    expect(await h.vault.newerDefaultGuide()).toBe(true);

    // The owner reviews it and saves their own wording: the current default counts as seen.
    await h.vault.updateOperatingGuide("# My own guide", "ui");
    expect(await h.vault.newerDefaultGuide()).toBe(false);

    // A later deploy ships yet another default.
    h.db.prepare(`UPDATE settings SET value = 'hash-of-an-older-default' WHERE key = 'guide_default_seen'`).run();
    expect(await h.vault.newerDefaultGuide()).toBe(true);
  });
});
