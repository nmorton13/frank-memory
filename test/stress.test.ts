import { describe, expect, it } from "vitest";
import { createWorker } from "./support/worker-harness";
import { vectorNear } from "./support/vault-harness";

// One vault grown to ~840 memories through MCP, checked step by step. The steps share state and run in order,
// so a failure names the step that broke.
describe("scale and stress (~840 memories)", () => {
  const w = createWorker();
  const { h } = w;

  // Count SQL queries to guard against O(N^2) regressions in background jobs.
  let sqlCount = 0;
  const sql = (h.vault as unknown as { sql: { exec: (q: string, ...args: unknown[]) => unknown } }).sql;
  const origExec = sql.exec.bind(sql);
  sql.exec = (q: string, ...args: unknown[]) => {
    sqlCount++;
    return origExec(q, ...args);
  };

  let claude: { access: string }, cursor: { access: string };
  const mcpCall = async (token: string, tool: string, args: Record<string, unknown>) => {
    const r = await w.call("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const text = await r.text();
    const jsonLine = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
    const inner = JSON.parse(jsonLine)?.result?.content?.[0]?.text;
    try { return { status: r.status, data: JSON.parse(inner) }; } catch { return { status: r.status, data: inner }; }
  };
  const drain = async (jobs: () => unknown[], maxAlarms = 400) => {
    let runs = 0;
    while (jobs().length > 0 && runs++ < maxAlarms) {
      h.makeAreaJobsDue();
      h.db.prepare(`UPDATE merge_jobs SET next_at = ?`).run(new Date(0).toISOString());
      await h.vault.alarm();
    }
    return runs;
  };

  // Area model: labels by keywords in the memory.
  h.state.chat = (prompt: string) => {
    if (prompt.startsWith("These memories")) {
      if (prompt.includes('area "home-network"')) return "Home network routers, VLANs, Wi-Fi, firewall rules";
      if (prompt.includes('area "frank-memory"')) return "Cloudflare Worker memory vault, MCP, Vectorize, SQLite";
      if (prompt.includes('area "lfkai"')) return "LFKai community site, events, local directory";
      if (prompt.includes('area "career"')) return "Work history, interviews, resume, engineering roles";
      if (prompt.includes('area "running"')) return "Half-marathon training, shoes, pace, weekly mileage";
      if (prompt.includes('area "cooking"')) return "Sourdough, espresso, cast iron, recipes";
      return "Project notes and decisions";
    }
    const memPart = prompt.split('"""')[1] || "";
    if (/router|vlan|ssid|wireguard|pfsense|unifi|switch|dns/i.test(memPart)) return '["home-network"]';
    if (/worker|durable object|vectorize|mcp|oauth|sqlite/i.test(memPart)) return '["frank-memory"]';
    if (/lfkai|lawrence|workshop|town|directory/i.test(memPart)) return '["lfkai"]';
    if (/resume|interview|staff engineer|salary|hiring|promotion/i.test(memPart)) return '["career"]';
    if (/marathon|tempo run|cadence|strava|garmin|vo2/i.test(memPart)) return '["running"]';
    if (/sourdough|espresso|grinder|hydration|fermentation/i.test(memPart)) return '["cooking"]';
    return "[]";
  };
  h.state.confirm = (prompt: string) => (prompt.includes("General personal context") ? "No." : "Yes.");
  // Merge model: only the dentist pair repeats one fact, and the fuller memory holds everything.
  h.state.merge = (prompt: string) => {
    const dentist = prompt.includes("Dr. Ortiz");
    if (prompt.startsWith("A personal memory vault sometimes")) return dentist ? "Yes." : "No.";
    if (prompt.startsWith("A personal memory vault wants")) return dentist ? "NOTHING MISSING" : "- a detail\nSOMETHING MISSING";
    return "";
  };
  // Clef: a memory helps if it shares a distinctive word with the question; a pair contradicts if one has a changed setting.
  h.state.clef = (state) => {
    if (state.pairs) return Object.fromEntries(Object.entries(state.pairs as Record<string, { memory_a: string; memory_b: string }>)
      .map(([k, p]) => [k, /setting 99999/.test(p.memory_a + p.memory_b) ? 0.97 : 0.02]));
    const words = (state.question as string).toLowerCase().match(/[a-z]{5,}/g) ?? [];
    return Object.fromEntries(Object.entries(state.memories as Record<string, string>)
      .map(([k, text]) => [k, words.some((wd) => text.toLowerCase().includes(wd)) ? 0.9 : 0.02]));
  };

  const areasData = [
    { area: "home-network", repo: "cursor: repo home-net", topic: "VLAN and router switch firewall configuration detail" },
    { area: "frank-memory", repo: "claude: repo frank-memory", topic: "Durable Object SQLite and Vectorize hybrid recall design" },
    { area: "lfkai", repo: "cursor: repo lfkai", topic: "LFKai community event listing and town directory page" },
    { area: "career", repo: "claude chat", topic: "Staff engineer interview preparation and system design architecture" },
    { area: "running", repo: "chatgpt export", topic: "Marathon training block tempo run mileage and Garmin heart rate" },
    { area: "cooking", repo: "claude chat", topic: "Sourdough starter hydration and espresso extraction recipe" },
  ];
  // 450 memories across 6 areas (75 each, 15 preferences per area) + 150 general (60 preferences).
  const bulkItems1: { content: string; type: string; source: string; source_date?: string }[] = [];
  for (const a of areasData) {
    for (let i = 0; i < 75; i++) {
      bulkItems1.push({
        content: `[${a.area} #${i}] ${a.topic} — specific parameter setting ${i * 10 + 7} with detailed rationale for why option ${i} was chosen over alternative ${i + 1}.`,
        type: i % 5 === 0 ? "decision" : i % 5 === 1 ? "preference" : i % 5 === 2 ? "project" : "fact",
        source: i < 25 ? a.repo : "chat",
        source_date: `2026-0${(i % 9) + 1}-${String((i % 28) + 1).padStart(2, "0")}`,
      });
    }
  }
  for (let i = 0; i < 150; i++) {
    bulkItems1.push({
      content: `General personal context #${i}: Sam prefers concise technical prose, keyboard shortcuts in editor workflow ${i}, and clear error messages when debugging system ${i}.`,
      type: i < 60 ? "preference" : "fact",
      source: "claude chat",
    });
  }
  const cookingQueryVec = h.embeddingOf("sourdough hydration espresso extraction");
  for (let i = 0; i < 5; i++) {
    const target = bulkItems1.find((it) => it.content.startsWith(`[cooking #${i}]`))!.content;
    h.embedAs(target, vectorNear(cookingQueryVec, 0.94, `cook_q_${i}`));
  }
  const dentistThin = "Sam's dentist is Dr. Ortiz";
  const dentistFull = "Sam's dentist is Dr. Ortiz, on Main Street in Denver";
  h.embedAs(dentistFull, vectorNear(h.embeddingOf(dentistThin), 0.9, "dentist"));

  it("connects two agents and imports 600 memories in one bulk import", async () => {
    claude = await w.connect("Claude Code");
    cursor = await w.connect("Cursor");
    const res = await mcpCall(claude.access, "bulk_remember", { items: bulkItems1, source: "initial-import" });
    expect(res.data).toMatchObject({ ok: true, added: 600, active: 600, indexed: 600 });
  }, 60_000);

  const rememberedIds: string[] = [];
  it("takes 150 single saves, 30 replacements and one repeated fact", async () => {
    for (let i = 0; i < 150; i++) {
      const r = await mcpCall(cursor.access, "remember", {
        content: `Incremental session memory #${i}: During coding session ${i}, we verified that service endpoint ${i} responds within ${10 + i}ms under load.`,
        type: i % 3 === 0 ? "decision" : "fact",
        source: i % 2 === 0 ? "cursor: repo frank-memory" : "cursor chat",
      });
      expect(r.data.ok).toBe(true);
      rememberedIds.push(r.data.id);
    }
    for (let i = 0; i < 30; i++) {
      const r = await mcpCall(cursor.access, "remember", {
        content: `Updated session memory #${i}: Service endpoint ${i} now responds within ${5 + i}ms after caching optimization.`,
        type: "decision", supersedes: rememberedIds[i],
      });
      expect(r.data).toMatchObject({ ok: true, supersedes: rememberedIds[i] });
    }
    for (const content of [dentistThin, dentistFull]) expect((await mcpCall(cursor.access, "remember", { content, type: "fact" })).data.ok).toBe(true);
  }, 60_000);

  it("labels areas in the background with linear SQL cost", async () => {
    expect(h.areaJobs().length).toBeGreaterThan(500);
    sqlCount = 0;
    await drain(() => h.areaJobs(), 100);
    expect(h.areaJobs()).toHaveLength(0);
    // Was >41,000 before background labeling stopped rescanning the whole table per job.
    expect(sqlCount).toBeLessThan(10_000);
    expect((await h.vault.listAreas()).map((a) => a.name))
      .toEqual(expect.arrayContaining(["career", "cooking", "frank-memory", "home-network", "lfkai", "running"]));
  }, 60_000);

  it("checks every new memory for a repeat with linear SQL cost, and merges only the real one", async () => {
    // Some were already checked during the labeling alarms above.
    expect(h.mergeJobs().length).toBeGreaterThan(600);
    sqlCount = 0;
    await drain(() => h.mergeJobs());
    expect(h.mergeJobs()).toHaveLength(0);
    expect(sqlCount).toBeLessThan(15_000);
    expect(await h.vault.listMerges()).toMatchObject([{ kept: true, into: { content: dentistFull }, from: [{ content: dentistThin }] }]);
  }, 120_000);

  it("sorts a second import into duplicates, near-duplicates, real conflicts and new items", async () => {
    const bulkItems2 = [
      ...bulkItems1.slice(0, 20),
      ...Array.from({ length: 20 }, (_, i) => {
        const orig = bulkItems1[20 + i].content;
        const cand = `${orig} (reworded slightly)`;
        h.embedAs(cand, vectorNear(h.embeddingOf(orig), 0.96, `nd_${i}`));
        return { content: cand, type: "fact" };
      }),
      ...Array.from({ length: 20 }, (_, i) => {
        const orig = bulkItems1[40 + i].content;
        const cand = orig.replace(/setting \d+/, `setting 99999${i}`);
        h.embedAs(cand, vectorNear(h.embeddingOf(orig), 0.95, `sim_${i}`));
        return { content: cand, type: "fact" };
      }),
      ...Array.from({ length: 40 }, (_, i) => ({ content: `Second wave import #${i}: New observation about distributed tracing span ${i}`, type: "note" })),
    ];
    const res = await mcpCall(claude.access, "bulk_remember", { items: bulkItems2, source: "second-import" });
    // The 20 changed settings are flagged because Clef finds each contradicts its original.
    expect(res.data).toMatchObject({ ok: true, added: 60, active: 60, possible_conflicts: 20, near_duplicates: 20, duplicates: 20 });
  }, 60_000);

  it("keeps agent recall within budget, with Clef judging and the question's area inferred", async () => {
    const named = await mcpCall(claude.access, "recall", { query: "How does frank-memory handle Vectorize indexing?" });
    expect(named.data.area).toBe("frank-memory");
    // The area has > 20 memories, so it isn't loaded whole.
    expect(named.data.complete).not.toContain("frank-memory");
    // Hits + one area's preferences (1,500 tokens) + general preferences (4,000 tokens), about 4 chars a token.
    expect(JSON.stringify(named.data).length).toBeLessThan(32_000);

    const implicit = await mcpCall(claude.access, "recall", { query: "sourdough hydration espresso extraction" });
    expect(implicit.data.area).toBe("cooking");
    // Cooking's 15 preferences fit 1,500 tokens; the 75-memory area doesn't.
    expect(implicit.data.complete).toContain("cooking preferences");
    // 60 general preferences are over the 40-memory limit: as many as fit load, and the result says so.
    expect(implicit.data.partial).toEqual([expect.stringMatching(/^general preferences: \d+ of 60 /)]);
    expect(implicit.data.results.filter((r: { content: string }) => r.content.startsWith("General personal context")).length).toBeGreaterThan(20);
  }, 60_000);

  it("falls back to scoring when Clef is down", async () => {
    const clef = h.state.clef;
    h.state.clef = null;
    const r = await h.vault.recall({ query: "sourdough hydration espresso extraction", complete: true });
    h.state.clef = clef;
    expect(r).not.toHaveProperty("judged");
    expect(r).toMatchObject({ area: "cooking" });
  }, 60_000);

  it("restores all 842 memories with their areas, labels and replacement links", async () => {
    const backupResp = await w.api("/backup");
    expect(backupResp.status).toBe(200);
    const w2 = createWorker();
    const restoreResp = await w2.api("/restore", "POST", await backupResp.json());
    expect(restoreResp.status).toBe(200);
    expect(await restoreResp.json()).toMatchObject({ ok: true, restored: { memories: 842 } });

    const snapshot = (db: typeof h.db) => db.prepare(`SELECT id, status, area, area_source, supersedes FROM memories ORDER BY id`).all();
    expect(snapshot(w2.h.db)).toEqual(snapshot(h.db));
    expect((await w2.h.vault.listAreas()).map((a) => a.name)).toEqual((await h.vault.listAreas()).map((a) => a.name));
    // The restored vault answers (keyword search works while its search index rebuilds).
    const r = await w2.h.vault.recall({ query: "Vectorize hybrid recall design", complete: true });
    expect(r.results.some((m) => m.content.includes("Vectorize hybrid recall design"))).toBe(true);
  }, 60_000);
});
