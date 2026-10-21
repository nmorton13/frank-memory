import { describe, expect, it } from "vitest";
import {
  bestMatch, classifySimilarity, contentHash, fillOwner, listIncludes, intParam, looksLikeSecret, meaningTokens, NEAR_DUP_SIM, parseRetentionDays, retentionCutoff,
  keywordStrengths, sanitizeFtsQuery, scoreRecallHit, SIMILAR_SIM, slimMemory, splitImportText, unitVector, withTimeout,
  areasNamedIn, chatText, normalizeArea, parseAreaNames, pickArea, repoFromSource,
} from "../src/helpers";

describe("splitImportText", () => {
  it("splits on --- separators", () => {
    expect(splitImportText("A is one\n---\nB is two\nstill two\n---\n")).toEqual([{ content: "A is one" }, { content: "B is two still two" }]);
  });
  it("splits bullets into items and drops headings", () => {
    expect(splitImportText("# Prefs\n- likes tea\n* hates meetings\n1. uses vim\n\nA paragraph\nwrapped.").map((i) => i.content))
      .toEqual(["likes tea", "hates meetings", "uses vim", "A paragraph wrapped."]);
  });
  it("accepts JSON arrays", () => {
    expect(splitImportText('["x", {"content":"y","type":"fact"}, {"content":"z","type":"bogus"}]'))
      .toEqual([{ content: "x" }, { content: "y", type: "fact", source: undefined, source_date: undefined }, { content: "z", type: undefined, source: undefined, source_date: undefined }]);
  });
  it("handles empty input", () => expect(splitImportText("  \n ")).toEqual([]));
});

describe("sanitizeFtsQuery", () => {
  it("quotes terms and ORs them, stripping operators", () => {
    expect(sanitizeFtsQuery('What does Sam prefer? NEAR(") -foo* "x"')).toBe('"sam" OR "prefer" OR "near" OR "foo"');
  });
  it("drops stopwords unless nothing else is left", () => {
    expect(sanitizeFtsQuery("what URL is frank-memory served at")).toBe('"url" OR "frank" OR "memory" OR "served"');
    expect(sanitizeFtsQuery("what is it")).toBe('"what" OR "is" OR "it"');
  });
  it("dedupes and returns null for nothing", () => {
    expect(sanitizeFtsQuery("tea tea TEA")).toBe('"tea"');
    expect(sanitizeFtsQuery("?! ()")).toBeNull();
  });
  it("keeps short numbers", () => expect(sanitizeFtsQuery("v 2")).toBe('"2"'));
});

describe("scoreRecallHit", () => {
  const now = Date.UTC(2026, 9, 14);
  const day = 86_400_000;
  it("ranks a strong proposed match above weak active matches (live regression, 2026-10-13)", () => {
    // Query "what URL is frank-memory served at": the right memory was proposed and scored 0.8143,
    // but ranked 7th behind active memories at 0.60-0.64 that only shared words like "at".
    const right = scoreRecallHit({ similarity: 0.8143, keyword: 0.3, status: "proposed", updatedAtMs: now }, now);
    for (const sim of [0.6397, 0.6303, 0.625, 0.6292, 0.6029, 0.6103]) {
      const wrong = scoreRecallHit({ similarity: sim, keyword: 1, status: "active", updatedAtMs: now - day }, now);
      expect(right).toBeGreaterThan(wrong);
    }
  });
  it("orders by similarity, then uses status and recency only to break near-ties", () => {
    const s = (similarity: number, status = "active", age = 0) => scoreRecallHit({ similarity, status, updatedAtMs: now - age * day }, now);
    expect(s(0.9)).toBeGreaterThan(s(0.8));
    expect(s(0.85, "proposed")).toBeGreaterThan(s(0.8, "active"));
    expect(s(0.8, "active")).toBeGreaterThan(s(0.8, "proposed"));
    expect(s(0.8, "active", 1)).toBeGreaterThan(s(0.8, "active", 400));
    expect(s(0.8, "proposed")).toBeGreaterThan(s(0.8, "superseded"));
  });
  it("adds keyword strength and saturates at the extremes", () => {
    const base = { status: "active", updatedAtMs: now };
    expect(scoreRecallHit({ ...base, similarity: 0.7, keyword: 1 }, now)).toBeGreaterThan(scoreRecallHit({ ...base, similarity: 0.7 }, now));
    expect(scoreRecallHit({ ...base, similarity: 1.2 }, now)).toBe(scoreRecallHit({ ...base, similarity: 1 }, now));
    expect(scoreRecallHit({ ...base, keyword: 1 }, now)).toBeGreaterThan(0);
  });
});

describe("keywordStrengths", () => {
  it("scales bm25 relative to the best hit", () => {
    const k = keywordStrengths([{ id: "a", bm25: -6 }, { id: "b", bm25: -3 }, { id: "c", bm25: -1.5 }]);
    expect(k.get("a")).toBe(1);
    expect(k.get("b")).toBeCloseTo(0.5);
    expect(k.get("c")).toBeCloseTo(0.25);
    expect(keywordStrengths([]).size).toBe(0);
  });
});

describe("looksLikeSecret", () => {
  it.each([
    "my key is sk-proj-abcdefghijklmnop1234",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "password: hunter22",
    "api_key=abcd1234efgh5678",
    "postgres://user:s3cret@db.example.com/x",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123",
  ])("flags %s", (s) => expect(looksLikeSecret(s)).toBe(true));
  it.each([
    "Sam prefers TypeScript over Python for Workers",
    "Rotate the API key every 90 days",
    "The password manager is 1Password",
  ])("allows %s", (s) => expect(looksLikeSecret(s)).toBe(false));
});

describe("misc", () => {
  it("hash normalizes whitespace and case", async () => expect(await contentHash(" Hello   World ")).toBe(await contentHash("hello world")));
});

import { cosine } from "../src/helpers";
describe("cosine", () => {
  it("computes similarity", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 2], [1])).toBe(0);
  });
});

describe("classifySimilarity", () => {
  // Pairs and scores measured against the live vault on 2026-10-13 (bge-base-en-v1.5).
  const existing = "Sam's home internet is 1 Gbps fiber.";
  it("skips a rewording with the same facts", () => {
    expect(classifySimilarity(0.9412, "Sam likes short domain names.", "Sam prefers short domain names.")).toBe("near_duplicate");
    expect(classifySimilarity(0.9458, "Sam turned off DNSSEC on 2026-10-12.", "DNSSEC was turned off on 2026-10-12 by Sam.")).toBe("near_duplicate");
  });
  it("sends lower-scoring rewordings to review rather than skipping", () => {
    expect(classifySimilarity(0.9171, "Sam's internet service is fiber at 1 Gbps.", existing)).toBe("similar");
  });
  it("sends contradictions and updates to review", () => {
    expect(classifySimilarity(0.8783, "Sam's home internet is 2 Gbps fiber.", existing)).toBe("similar");
    expect(classifySimilarity(0.8859, "Sam prefers long, descriptive domain names.", "Sam prefers short domain names.")).toBe("similar");
  });
  it("never skips when a number, version or date differs, however close the vectors", () => {
    expect(classifySimilarity(0.99, "Router runs Merlin 388.12_2.", "Router runs Merlin 388.9_2.")).toBe("similar");
    expect(classifySimilarity(0.99, "Lease expires 2027-10-08.", "Lease expires 2026-10-08.")).toBe("similar");
  });
  it("never skips when a negation differs", () => {
    expect(classifySimilarity(0.97, "Sam does not use Skynet.", "Sam uses Skynet.")).toBe("similar");
    expect(classifySimilarity(0.97, "Auto-renew is disabled.", "Auto-renew is on.")).toBe("similar");
  });
  it("treats unrelated items as new", () => {
    expect(classifySimilarity(0.6071, "Sam prefers dark mode.", "Sam prefers short domain names.")).toBe("new");
    expect(classifySimilarity(SIMILAR_SIM - 0.001, "a", "b")).toBe("new");
  });
  it("keeps the skip bar above the review bar", () => expect(NEAR_DUP_SIM).toBeGreaterThan(SIMILAR_SIM));
});

describe("meaningTokens", () => {
  it("collects numbers, versions, IPs and negations, ignoring trailing punctuation", () => {
    expect(meaningTokens("Router 10.0.0.1 runs 2.4.1_7, not stock.")).toBe(["10.0.0.1", "2.4.1_7", "not"].sort().join("|"));
    expect(meaningTokens("No numbers here")).toBe("no");
    expect(meaningTokens("Plain words")).toBe("");
  });
});

describe("bestMatch / unitVector", () => {
  it("finds the closest unit vector and reports cosine", () => {
    const q = unitVector([1, 0]);
    const pool = [{ id: "a", vec: unitVector([0, 1]) }, { id: "b", vec: unitVector([3, 1]) }, { id: "bad", vec: unitVector([1, 0, 0]) }];
    const m = bestMatch(q, pool)!;
    expect(m.item.id).toBe("b");
    expect(m.sim).toBeCloseTo(3 / Math.sqrt(10), 6);
  });
  it("returns null for an empty pool", () => expect(bestMatch(unitVector([1]), [])).toBeNull());
});

describe("listIncludes", () => {
  it("matches case-insensitively against a comma list", () => {
    expect(listIncludes("Sam.Owner@example.com", "x@y.z, sam.owner@example.com")).toBe(true);
    expect(listIncludes("other@example.com", "sam.owner@example.com")).toBe(false);
    expect(listIncludes(undefined, "a@b.c")).toBe(false);
    expect(listIncludes("a@b.c", "")).toBe(false);
    expect(listIncludes("abc123.access", "def.access,ABC123.access")).toBe(true);
  });
});

describe("intParam", () => {
  it("clamps and falls back on junk", () => {
    expect(intParam("abc", 50, 1, 500)).toBe(50);
    expect(intParam(null, 50, 1, 500)).toBe(50);
    expect(intParam("9999", 50, 1, 500)).toBe(500);
    expect(intParam("-3", 0, 0, 10)).toBe(0);
    expect(intParam("7.9", 1, 1, 10)).toBe(7);
  });
});

describe("fillOwner", () => {
  it("fills every placeholder with the name or a neutral default", () => {
    const t = "{Owner's} vault. Ask {owner}. {Owner} approves {owner's} queue.";
    expect(fillOwner(t, "Sam")).toBe("Sam's vault. Ask Sam. Sam approves Sam's queue.");
    expect(fillOwner(t)).toBe("The vault owner's vault. Ask the vault owner. The vault owner approves the vault owner's queue.");
    expect(fillOwner(t, "  ")).toBe(fillOwner(t));
  });
});

describe("owner-facing text", () => {
  it("leaves no placeholders and names no one by default", async () => {
    const { defaultGuide } = await import("../src/guide");
    const { connectInstructions } = await import("../src/connect");
    for (const text of [defaultGuide(), defaultGuide("Sam"), connectInstructions("https://m.example", "Sam"), connectInstructions("https://m.example")]) {
      expect(text).not.toMatch(/\{owner|\{Owner/);
      expect(text).not.toMatch(/\bhis\b|\bhe\b|\bhim\b|\bher\b|\bshe\b/);
    }
    expect(defaultGuide("Sam")).toContain("- Sam's **current request always governs**.");
    expect(defaultGuide()).toContain("The vault owner owns this vault");
    expect(connectInstructions("https://m.example", "Sam")).toContain("https://m.example/mcp");
  });
});

describe("memory types", () => {
  it("has no task type", async () => {
    const { isMemoryType, MEMORY_TYPES } = await import("../src/helpers");
    expect(MEMORY_TYPES).not.toContain("task");
    expect(isMemoryType("task")).toBe(false);
    const { defaultGuide } = await import("../src/guide");
    expect(defaultGuide()).not.toMatch(/`task`|\| task \|/);
  });
});

describe("slimMemory", () => {
  it("drops bookkeeping and nulls, shortens dates", () => {
    const s = slimMemory({
      id: "mem_1", content: "Sam uses X", type: "fact", status: "proposed", source: null, source_date: "2026-10-01",
      confirmed_at: null, updated_at: "2026-10-13T23:55:11.247Z", supersedes: null, similar_to: "mem_0", score: 0.912345,
      ...({ content_hash: "abc", batch_id: "b", similar_content: "old text", created_at: "x" } as object),
    });
    expect(s).toEqual({ id: "mem_1", type: "fact", status: "proposed", content: "Sam uses X", source_date: "2026-10-01",
      updated: "2026-10-13", imported: true, review_with: "mem_0", score: 0.912 });
  });
  it("marks only batch items as imported", () => {
    expect(slimMemory({ id: "a", content: "c", type: "note", status: "active", batch_id: null })).not.toHaveProperty("imported");
  });
  it("omits review_with once the item is no longer proposed", () => {
    expect(slimMemory({ id: "a", content: "c", type: "note", status: "active", similar_to: "b" })).not.toHaveProperty("review_with");
  });
});

describe("retention", () => {
  it("computes cutoffs, with 0 meaning keep forever", () => {
    const now = Date.parse("2026-10-14T00:00:00Z");
    expect(retentionCutoff(30, now)).toBe("2026-09-14T00:00:00.000Z");
    expect(retentionCutoff(0, now)).toBeNull();
    expect(retentionCutoff(NaN, now)).toBeNull();
  });
  it("parses whole days in range only", () => {
    expect(parseRetentionDays("365")).toBe(365);
    expect(parseRetentionDays(0)).toBe(0);
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("1.5")).toBeNull();
    expect(parseRetentionDays(-1)).toBeNull();
    expect(parseRetentionDays(5000)).toBeNull();
  });
  it("flags active possible conflicts only while the other memory is active", () => {
    const base = { id: "a", content: "c", type: "fact", status: "active", similar_to: "b" };
    expect(slimMemory({ ...base, similar_status: "active" }).may_conflict_with).toBe("b");
    expect(slimMemory({ ...base, similar_status: "superseded" })).not.toHaveProperty("may_conflict_with");
  });
});

describe("withTimeout", () => {
  it("passes a prompt result through and rejects a slow one", async () => {
    expect(await withTimeout(Promise.resolve(7), 50, "x")).toBe(7);
    await expect(withTimeout(new Promise(() => {}), 20, "embedding")).rejects.toThrow("embedding timed out after 20 ms");
  });
});

describe("areas", () => {
  const areas = [{ name: "frank-memory", aliases: [] }, { name: "lfkai", aliases: [] }, { name: "home-network", aliases: ["aimesh"] }];

  it("normalizes names", () => {
    expect(normalizeArea("LFKai.town")).toBe("lfkai");
    expect(normalizeArea(" Frank_Memory ")).toBe("frank-memory");
    expect(normalizeArea("HodlJuice.app")).toBe("hodljuice");
    expect(normalizeArea("General")).toBeNull();
    expect(normalizeArea("")).toBeNull();
  });

  it("reads the repo from a source", () => {
    expect(repoFromSource("claude-code: repo frank-memory (via Claude Code)")).toBe("frank-memory");
    expect(repoFromSource("cursor: repo LFKai")).toBe("lfkai");
    expect(repoFromSource("claude chat")).toBeNull();
  });

  it("finds area names as whole words", () => {
    expect(areasNamedIn("Frank Memory is deployed", areas)).toEqual(["frank-memory"]);
    expect(areasNamedIn("bought lfkai.town", areas)).toEqual(["lfkai"]);
    expect(areasNamedIn("the AiMesh node", areas)).toEqual(["home-network"]);
    expect(areasNamedIn("xlfkai and lfkaix", areas)).toEqual([]);
  });

  it("picks an area by rule", () => {
    const note = (content: string, source?: string) => ({ content, type: "note", source });
    expect(pickArea(note("x", "repo lfkai"), {}, areas)).toEqual({ area: "lfkai", source: "source", hint: null });
    expect(pickArea(note("x", "repo newthing"), {}, areas)).toEqual({ area: null, source: null, hint: "newthing" });
    expect(pickArea(note("the LFKai domain"), {}, areas)).toEqual({ area: null, source: null, hint: null });
    expect(pickArea(note("LFKai uses frank-memory"), {}, areas).area).toBeNull();
    expect(pickArea(note("x", "repo lfkai"), { explicit: "Garden" }, areas)).toEqual({ area: null, source: "agent", hint: "garden" });
    expect(pickArea(note("x"), { inherited: "lfkai" }, areas)).toEqual({ area: "lfkai", source: "inherited", hint: null });
    const pref = { content: "Nate is used in the LFKai byline", type: "preference", source: "repo lfkai" };
    expect(pickArea(pref, {}, areas).area).toBeNull();
  });

  it("gives hits in the question's area a bonus", () => {
    const base = { similarity: 0.8, status: "active", updatedAtMs: 0 };
    expect(scoreRecallHit({ ...base, inArea: true }, 0)).toBeCloseTo(scoreRecallHit(base, 0) + 0.1);
  });
});

describe("area model answers", () => {
  it("parses arrays, bare names and 'none'", () => {
    expect(parseAreaNames('["lfkai"]')).toEqual(["lfkai"]);
    expect(parseAreaNames("Sure: []")).toEqual([]);
    expect(parseAreaNames("home-network")).toEqual(["home-network"]);
    expect(parseAreaNames('"None."')).toEqual([]);
    expect(parseAreaNames("I think this memory is mostly about\nthe router")).toBeNull();
  });

  it("treats generic names as no area", () => {
    for (const n of ["The Project", "work", "Technology", "home", "general"]) expect(normalizeArea(n)).toBeNull();
    expect(normalizeArea("Home Network")).toBe("home-network");
  });

  it("counts a preference's repo toward creating the area without labeling it", () => {
    expect(pickArea({ content: "x", type: "preference", source: "repo lfkai" }, {}, [])).toEqual({ area: null, source: null, hint: "lfkai" });
  });
});

describe("chatText", () => {
  it("reads the answer in each Workers AI shape", () => {
    expect(chatText({ response: "lfkai" })).toBe("lfkai");
    expect(chatText({ response: ["home network"], choices: [{ message: { content: '["home network"]' } }] })).toBe('["home network"]');
    expect(chatText({ response: ["home network"] })).toBe('["home network"]');
    expect(chatText({})).toBe("");
    expect(parseAreaNames("")).toBeNull();
  });
});
