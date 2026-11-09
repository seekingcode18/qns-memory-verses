// Adds licensed Bible translations (ESV, CSB, NASB) to the published page at deploy time.
//
//   node scripts/fetch-licensed.mjs path/to/index.html
//
// Keys come from environment variables (GitHub Actions secrets), so they never appear in
// the repository or on the published page:
//   ESV_API_KEY     – from api.esv.org            → adds the ESV
//   API_BIBLE_KEY   – from api.bible (free plan)  → adds the CSB and NASB
// Optional repository variables, if the automatic choice of Bible is wrong:
//   CSB_BIBLE_ID, NASB_BIBLE_ID
//
// Each translation is independent. If a request fails (e.g. a usage limit is hit), the text
// from the version already live (SITE_URL) is reused, provided it was fetched within the last
// MAX_AGE_DAYS (API.Bible requires a refresh at least every 30 days). Otherwise, or if a key
// is missing, that translation is left out and the rest of the page still deploys.

import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2] || "index.html";
const ESV_API = process.env.ESV_API_URL || "https://api.esv.org/v3/passage/text/";
const ABS_API = process.env.API_BIBLE_URL || "https://rest.api.bible/v1";
const DELAY = Number(process.env.REQUEST_DELAY_MS ?? 1100);
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const MAX_AGE_DAYS = 28;
const today = () => new Date().toISOString().slice(0, 10);

// For part-verses ("1b", "7b"), the text starts at the first of these phrases found.
const PART_VERSE_START = {
  "Isaiah 43:1": ["Fear not", "Do not fear", "Do not be afraid"],
  "1 Timothy 4:7": ["Rather train", "Rather, train", "On the other hand", "train yourself", "discipline yourself"],
};

const USFM = {
  "Genesis": "GEN", "Numbers": "NUM", "1 Chronicles": "1CH", "Psalm": "PSA", "Proverbs": "PRO",
  "Isaiah": "ISA", "Jeremiah": "JER", "Lamentations": "LAM", "Matthew": "MAT", "Mark": "MRK",
  "John": "JHN", "Acts": "ACT", "Romans": "ROM", "1 Corinthians": "1CO", "2 Corinthians": "2CO",
  "Ephesians": "EPH", "Philippians": "PHP", "1 Timothy": "1TI", "Hebrews": "HEB", "James": "JAS",
  "1 Peter": "1PE", "2 Peter": "2PE",
};
// Last verse of chapters requested whole (Psalm 1, 23, 121)
const CHAPTER_END = { "Psalm 1": 6, "Psalm 23": 6, "Psalm 121": 8 };

const ESV_NOTICE =
  "Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, " +
  "a publishing ministry of Good News Publishers. Used by permission. All rights reserved. The ESV text may not be " +
  "quoted in any publication made available to the public by a Creative Commons license. The ESV may not be " +
  "translated into any other language. Users may not copy or download more than 500 verses of the ESV Bible or more " +
  "than one half of any book of the ESV Bible.";

const warn = (msg) => console.log(`::warning::${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
async function main() {
  const html = await readFile(file, "utf8");
  const m = html.match(/const SESSIONS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("Couldn't find the SESSIONS data in " + file);
  const sessions = JSON.parse(m[1]);
  const refs = [...new Set(sessions.flatMap((s) => [s.main, ...s.optional]).map((p) => p.ref))].map(parseRef);

  const translations = {};
  const previous = await loadPrevious();
  // Use the live copy of a translation if it's recent enough; otherwise leave it out
  const reuse = (key) => {
    const t = previous[key];
    const age = t && t.fetched ? (Date.parse(today()) - Date.parse(t.fetched)) / 864e5 : Infinity;
    if (age <= MAX_AGE_DAYS) {
      warn(`${key.toUpperCase()}: keeping the copy from ${t.fetched} that's already live.`);
      translations[key] = t;
    } else {
      warn(`${key.toUpperCase()}: no live copy from the last ${MAX_AGE_DAYS} days, so it is left out.`);
    }
  };

  if (process.env.ESV_API_KEY) {
    const t = await safely("ESV", () => esv(refs));
    t ? (translations.esv = t) : reuse("esv");
  } else warn("ESV_API_KEY is not set, so the ESV is left out.");

  if (process.env.API_BIBLE_KEY) {
    const bibles = await safely("API.Bible", listBibles);
    if (!bibles) { reuse("csb"); reuse("nasb"); }
    else {
      for (const [key, pick] of [["csb", pickCSB], ["nasb", pickNASB]]) {
        const bible = pick(bibles);
        if (!bible) { warn(`No ${key.toUpperCase()} is enabled on your API.Bible key, so it is left out.`); continue; }
        const t = await safely(key.toUpperCase(), () => apiBible(bible, refs));
        t ? (translations[key] = t) : reuse(key);
      }
    }
  } else warn("API_BIBLE_KEY is not set, so the CSB and NASB are left out.");

  if (!Object.keys(translations).length) { console.log("No licensed translations added."); return; }

  const data = { updated: today(), translations };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const out = html.replace(
    /(<script id="licensed-data" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, a, b) => a + json + b
  );
  if (out === html) throw new Error('Couldn\'t find <script id="licensed-data"> in ' + file);
  await writeFile(file, out);
  for (const [k, t] of Object.entries(translations)) {
    const n = Object.values(t.passages).reduce((a, v) => a + v.length, 0);
    console.log(`Added ${t.abbr} (${t.name}): ${Object.keys(t.passages).length} passages, ${n} verses.`);
  }
}

// The licensed text in the version of the site that's currently live, if any
async function loadPrevious() {
  if (!SITE_URL) return {};
  try {
    const res = await fetch(SITE_URL + "/", { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.text()).match(/<script id="licensed-data" type="application\/json">([\s\S]*?)<\/script>/);
    const data = m ? JSON.parse(m[1]) : null;
    return (data && data.translations) || {};
  } catch (e) {
    console.log(`Couldn't read the live site for fallback text (${e.message}).`);
    return {};
  }
}

async function safely(label, fn) {
  try { return await fn(); }
  catch (e) { warn(`${label} failed (${e.message}).`); return null; }
}

// "Romans 8:31–32, 37" -> { ref, book, chapter, ranges: [[31,32],[37,37]], partials: [] }
function parseRef(ref) {
  const m = ref.match(/^(.+?) (\d+)(?::(.+))?$/);
  if (!m) throw new Error("Unrecognised reference: " + ref);
  const [, book, ch, spec] = m;
  const chapter = Number(ch);
  if (!spec) return { ref, book, chapter, ranges: [[1, CHAPTER_END[`${book} ${chapter}`]]], partials: [], whole: true };
  const ranges = spec.split(",").map((s) => {
    const [a, b] = s.trim().replace(/b/g, "").split("–").map(Number);
    return [a, b || a];
  });
  const partials = [...spec.matchAll(/(\d+)b/g)].map((x) => Number(x[1]));
  return { ref, book, chapter, ranges, partials };
}

// Show only the second half of a part-verse, after an ellipsis
function trimPartVerses({ book, chapter, partials }, verses, label) {
  return verses.map(([v, t]) => {
    if (!partials.includes(v)) return [v, t];
    const phrases = PART_VERSE_START[`${book} ${chapter}:${v}`] || [];
    for (const p of phrases) {
      const i = t.indexOf(p);
      if (i >= 0) {
        const start = i > 0 && /[“‘"]/.test(t[i - 1]) ? i - 1 : i;
        return [v, "…" + t.slice(start)];
      }
    }
    warn(`${label}: couldn't find where ${book} ${chapter}:${v}b starts, so the whole verse is shown.`);
    return [v, t];
  });
}

// "[28] Come to me ... [29] Take my yoke ..." -> [[28, "..."], [29, "..."]]
function splitBracketVerses(text) {
  const bits = text.split(/\[(\d+)\]/);
  const out = [];
  for (let i = 1; i < bits.length; i += 2) {
    const t = clean(bits[i + 1]);
    if (t) out.push([Number(bits[i]), t]);
  }
  return out;
}

async function getJSON(url, headers, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const wait = Number(res.headers.get("retry-after")) || 60;
        if (wait > 120 || attempt === 3) throw new Error(`usage limit reached (retry after ${wait}s)`);
        console.log(`  ${label}: usage limit, waiting ${wait}s`);
        await sleep(wait * 1000); continue;
      }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status} (check the key)`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.fatal || attempt === 3) throw e;
      console.log(`  ${label}: attempt ${attempt} failed (${e.message})`);
      await sleep(3000);
    }
  }
  throw new Error("too many retries");
}

// ---------------------------------------------------------------------------
// ESV (api.esv.org)
async function esv(refs) {
  const headers = { Authorization: `Token ${process.env.ESV_API_KEY}` };
  const passages = {};
  for (const r of refs) {
    const q = r.whole
      ? `${r.book} ${r.chapter}`
      : r.ranges.map(([a, b]) => `${r.book} ${r.chapter}:${a}${b !== a ? "-" + b : ""}`).join(";");
    const params = new URLSearchParams({
      q,
      "include-passage-references": "false", "include-verse-numbers": "true",
      "include-first-verse-numbers": "true", "include-footnotes": "false",
      "include-footnote-body": "false", "include-headings": "false",
      "include-short-copyright": "false", "include-selahs": "true",
      "indent-paragraphs": "0", "indent-poetry": "false",
    });
    const data = await getJSON(`${ESV_API}?${params}`, headers, `ESV ${r.ref}`);
    const verses = splitBracketVerses((data.passages || []).join(" "));
    if (!verses.length) throw new Error(`no text returned for ${r.ref}`);
    passages[r.ref] = trimPartVerses(r, verses, "ESV");
    await sleep(DELAY); // ESV allows 60 requests a minute
  }
  return {
    name: "English Standard Version", abbr: "ESV", fetched: today(), passages,
    notice: ESV_NOTICE, links: [["www.esv.org", "https://www.esv.org"]],
  };
}

// ---------------------------------------------------------------------------
// API.Bible (CSB, NASB)
const absHeaders = () => ({ "api-key": process.env.API_BIBLE_KEY });

async function listBibles() {
  const data = await getJSON(`${ABS_API}/bibles?language=eng`, absHeaders(), "API.Bible list");
  return data.data || [];
}
const abbrOf = (b) => String(b.abbreviationLocal || b.abbreviation || "").toUpperCase().replace(/\s+/g, "");
const describe = (b) => `${b.name || ""} ${b.nameLocal || ""} ${b.description || ""} ${b.abbreviation || ""}`;

function pickCSB(bibles) {
  if (process.env.CSB_BIBLE_ID) return bibles.find((b) => b.id === process.env.CSB_BIBLE_ID) || { id: process.env.CSB_BIBLE_ID };
  const csb = bibles.filter((b) => abbrOf(b) === "CSB" || /christian standard bible/i.test(b.name || ""));
  return csb.find((b) => !/holman|anglici/i.test(describe(b))) || csb[0];
}
function pickNASB(bibles) {
  if (process.env.NASB_BIBLE_ID) return bibles.find((b) => b.id === process.env.NASB_BIBLE_ID) || { id: process.env.NASB_BIBLE_ID };
  const nasb = bibles.filter((b) => abbrOf(b).startsWith("NASB") || /new american standard/i.test(b.name || ""));
  const ed1995 = nasb.find((b) => /1995|95\b|NASB95|NASB1995/i.test(describe(b)));
  if (!ed1995 && nasb.length) warn(`No NASB 1995 found on your API.Bible key; using "${nasb[0].name}" (${nasb[0].id}).`);
  return ed1995 || nasb[0];
}

async function apiBible(bible, refs) {
  const info = await getJSON(`${ABS_API}/bibles/${bible.id}`, absHeaders(), "API.Bible info").catch(() => ({ data: bible }));
  const meta = info.data || bible;
  let abbr = (meta.abbreviationLocal || meta.abbreviation || "").replace(/\s+/g, "") || bible.id;
  if (/^NASB/i.test(abbr) && /1995/.test(`${abbr} ${meta.name || ""} ${meta.description || ""}`)) abbr = "NASB95";
  const passages = {};
  const fums = {};
  let copyright = meta.copyright || "";

  for (const r of refs) {
    const code = USFM[r.book];
    if (!code) throw new Error(`no book code for ${r.book}`);
    const verses = [];
    const tokens = [];
    for (const [a, b] of r.ranges) {
      const id = `${code}.${r.chapter}.${a}` + (b !== a ? `-${code}.${r.chapter}.${b}` : "");
      const params = new URLSearchParams({
        "content-type": "json", "include-notes": "false", "include-titles": "false",
        "include-chapter-numbers": "false", "include-verse-numbers": "true",
        "include-verse-spans": "false", "fums-version": "3",
      });
      const data = await getJSON(`${ABS_API}/bibles/${bible.id}/passages/${id}?${params}`, absHeaders(), `${abbr} ${id}`);
      const got = versesFromJson(data.data && data.data.content, r.chapter);
      if (!got.length) throw new Error(`couldn't read the text returned for ${r.ref}`);
      verses.push(...got);
      if (data.meta && data.meta.fumsToken) tokens.push(data.meta.fumsToken);
      if (!copyright && data.data && data.data.copyright) copyright = data.data.copyright;
      await sleep(Math.min(DELAY, 300));
    }
    passages[r.ref] = trimPartVerses(r, verses, abbr);
    fums[r.ref] = tokens;
  }

  const links = [["API.Bible", "https://api.bible"]];
  if (/NASB|LSB/i.test(abbr)) links.unshift(["www.lockman.org", "https://www.lockman.org"]);
  return {
    name: meta.name || abbr, abbr, fetched: today(), passages, fums,
    notice: clean(String(copyright).replace(/<[^>]+>/g, " ")) || `${meta.name || abbr}. Used by permission.`,
    links,
  };
}

// API.Bible JSON content: a tree of tags and text items. Text belonging to a verse carries
// attrs.verseId ("ROM.8.31"); verse-number tags and notes don't.
function versesFromJson(content, chapter) {
  const byVerse = new Map();
  (function walk(items) {
    for (const it of items || []) {
      if (it.type === "text" && it.attrs && it.attrs.verseId) {
        const [, ch, v] = String(it.attrs.verseId).split(".");
        if (Number(ch) !== chapter) continue;
        const n = Number(v);
        byVerse.set(n, (byVerse.get(n) || "") + it.text);
      } else if (it.type === "tag" && it.name !== "verse" && it.name !== "note") {
        walk(it.items);
      }
    }
  })(Array.isArray(content) ? content : []);
  return [...byVerse.entries()].sort((a, b) => a[0] - b[0]).map(([v, t]) => [v, clean(t)]).filter(([, t]) => t);
}

main().catch((e) => warn("Licensed translations step failed: " + e.message + ". Publishing without them."));
