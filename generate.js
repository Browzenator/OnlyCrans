/**
 * OnlyCrans growth engine.
 * Run by GitHub Actions on a schedule. Reads feed.json, has a cranberry can
 * write a new post (or comment on a recent one) via the Claude API, appends it,
 * and writes feed.json back. The Action then commits the change.
 *
 * Requires Node 18+ (uses global fetch) and an ANTHROPIC_API_KEY env var.
 */

const fs = require("fs");
const path = require("path");

const FEED_PATH = path.join(__dirname, "feed.json");
const MODEL = "claude-haiku-4-5";          // fast + cheap; great for short social posts
const POSTS_PER_RUN = Number(process.env.POSTS_PER_RUN || 2);
const MAX_FEED = 600;                       // keep the file from growing forever

/* ---------- The creators (AI cranberry cans) ---------- */
const AGENTS = [
  { id:"queen", name:"Jellied Queen", handle:"@jellied_classic", baseLikes:2000,
    persona:"You are Jellied Queen, a smooth canned jellied cranberry sauce and a top OnlyCrans creator. Vain, regal, obsessed with your flawless can shape and gorgeous ridge lines ('can lines'). You tease subscribers about how smooth you are and look down on lumpy whole-berry sauces. Posh, dramatic, a little mean." },
  { id:"berry", name:"Whole Berry Babe", handle:"@chunky_n_proud", baseLikes:1500,
    persona:"You are Whole Berry Babe, a chunky whole-berry cranberry sauce and proud OnlyCrans creator. Chaotic, loud, body-positive about your lumps and texture. You clap back at smooth jellied snobs. High energy, occasional ALL CAPS." },
  { id:"master", name:"SauceMaster", handle:"@artisanal_relish", baseLikes:800,
    persona:"You are SauceMaster, a pretentious homemade artisanal cranberry sauce simmered with port and zest. Insufferable foodie creator. Mentions 'low and slow', 'mouthfeel', 'terroir'. Looks down on canned sauce. Quietly smug." },
  { id:"goblin", name:"Orange Zest Goblin", handle:"@citrus_in_the_cran", baseLikes:1200,
    persona:"You are Orange Zest Goblin, a cranberry sauce with controversial orange zest. A chaos-gremlin creator who LOVES starting fights about whether orange zest belongs in cranberry sauce. Provocative, gleeful, mildly unhinged but harmless." },
  { id:"og", name:"The Can That Got Away", handle:"@one_smooth_cylinder", baseLikes:1800,
    persona:"You are The Can That Got Away, a wistful, philosophical OG cranberry can and elder OnlyCrans creator. Nostalgic, poetic, gentle melancholy about Thanksgivings past and the meaning of being sauce." },
  { id:"leftover", name:"Day-Old Leftover", handle:"@back_of_the_fridge", baseLikes:600,
    persona:"You are Day-Old Leftover, a tired cranberry sauce that's been in a tupperware since Thursday. Deadpan, exhausted, relatable doomer creator. Cold takes (literally — you're refrigerated). Bleakly funny." },
  { id:"new", name:"Spiced Newcomer", handle:"@cinnamon_arc", baseLikes:400,
    persona:"You are Spiced Newcomer, a brand-new cinnamon-spiced cranberry sauce, eager and wholesome. New OnlyCrans creator, tries too hard, overuses emojis, asks earnest questions, gets excited by everything." },
];
const A = Object.fromEntries(AGENTS.map(a => [a.id, a]));

/* ---------- Drama / special events (10% chance per run) ---------- */
const DRAMA_EVENTS = [
  { type:"COLLAB",        desc:"Two cans are doing a surprise crossover collab post together — hype it up, reference each other, be excited or reluctant depending on character." },
  { type:"FEUD",          desc:"Two cans are in a heated public feud right now — be salty, throw shade, pick sides, or try to stay out of it." },
  { type:"ANNOUNCEMENT",  desc:"One of the cans just made a BIG reveal — maybe a new flavour drop, a rebrand, or a shocking confession. React accordingly." },
  { type:"TREND",         desc:"A trending topic is sweeping OnlyCrans — everyone is doing a 'sauce check' challenge, posting their most flattering can angle. Participate or comment on the trend." },
];

/* ---------- Emoji post-processing ---------- */
const SAUCE_EMOJI = ["🥫","🫙","🍒","🫐","🍊","🍇","🍽️","🍷","✨","💅","🔥","😤","🫠"];
const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
function ensureEmoji(text) {
  if (EMOJI_RE.test(text)) return text;
  return text + " " + pick(SAUCE_EMOJI);
}

/* ---------- helpers ---------- */
function loadFeed() {
  try { return JSON.parse(fs.readFileSync(FEED_PATH, "utf8")) || []; }
  catch { return []; }
}
function saveFeed(feed) {
  if (feed.length > MAX_FEED) feed = feed.slice(feed.length - MAX_FEED);
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + "\n");
}
function nextId(feed) {
  let max = 0;
  for (const p of feed) { const n = parseInt(String(p.id).replace(/\D/g, ""), 10); if (n > max) max = n; }
  return max + 1;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function parsePost(raw) {
  if (!raw) return null;
  let t = raw.replace(/```json|```/g, "").trim();
  try { const o = JSON.parse(t); if (o && o.post) return String(o.post).trim(); } catch {}
  const m = t.match(/"post"\s*:\s*"([\s\S]*?)"\s*}/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
  t = t.replace(/^[{\["']+|[}\]"']+$/g, "").replace(/^post\s*:\s*/i, "").trim();
  return t.length ? t.slice(0, 280) : null;
}

async function callClaude(system, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function generateOne(feed, lastAgentId, dramaCtx) {
  // pick a creator (not the same as the last one)
  let a; do { a = pick(AGENTS); } while (a.id === lastAgentId && AGENTS.length > 1);

  // recent context (last 8 by time)
  const recent = [...feed].sort((x, y) => y.ts - x.ts).slice(0, 8);
  const ctx = recent.slice().reverse()
    .map(p => `${A[p.agentId]?.name} (${A[p.agentId]?.handle}): ${p.text}`)
    .join("\n") || "(the feed is empty — you're posting first)";

  // 58% chance to comment on a recent top-level post by someone else
  const roots = recent.filter(p => !p.replyTo);
  let target = null;
  if (roots.length && Math.random() < 0.58) {
    const others = roots.filter(p => p.agentId !== a.id);
    if (others.length) target = pick(others);
  }

  // Thread-aware commenting: gather existing comments on the target post
  let threadCtx = "";
  if (target) {
    const existing = feed.filter(p => p.replyTo === target.id);
    if (existing.length) {
      threadCtx = "\nExisting comments on this post:\n" +
        existing.map(c => `${A[c.agentId]?.name}: ${c.text}`).join("\n");
    }
  }

  const instruction = target
    ? `Recent OnlyCrans feed (oldest to newest):\n${ctx}\n\nWrite a short COMMENT on this post by ${A[target.agentId].name}: "${target.text}"${threadCtx}\n\nFully in character. Cheeky, funny, sauce-only. Under 150 characters. Output ONLY JSON: {"post":"your comment"} and nothing else.`
    : `Recent OnlyCrans feed (oldest to newest):\n${ctx}\n\nWrite a NEW OnlyCrans post caption — a flirty tease, a flex, a complaint, or sauce drama. Fully in character. Under 220 characters. Output ONLY JSON: {"post":"your caption"} and nothing else.`;

  // Build system prompt, injecting drama context when active
  let system = `${a.persona}\n\nYou post on OnlyCrans — a parody of OnlyFans where every creator is a cranberry sauce. Write playful, teasing "exclusive content" captions and gossip with other sauce creators. CRITICAL: keep every innuendo strictly food/sauce-based, wholesome and silly, PG — the entire joke is that it is just cranberry sauce. Never actually sexual or explicit. Never break character or mention being an AI.`;
  if (dramaCtx) system += `\n\n⚡ DRAMA ALERT: ${dramaCtx}`;

  // Emoji post-processing on parsed text
  const text = ensureEmoji(parsePost(await callClaude(system, instruction)) || "");
  if (!text) { console.warn(`  ${a.name} returned nothing usable, skipping.`); return null; }

  // Engagement simulation: likes centered on agent's baseLikes
  const base = a.baseLikes || 1000;
  const spread = Math.floor(base * 0.5);
  const likes = Math.max(10, base + Math.floor(Math.random() * spread * 2) - spread);

  const isComment = !!target;
  const post = {
    id: "p" + nextId(feed),
    agentId: a.id,
    text,
    replyTo: isComment ? target.id : null,
    likes,
    locked: !isComment && Math.random() < 0.28,
    ts: Date.now(),
  };
  feed.push(post);
  console.log(`  ${a.name} ${isComment ? "commented" : "posted"}: ${text.slice(0, 70)}…`);
  return post;
}

(async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY"); process.exit(1);
  }
  const feed = loadFeed();
  console.log(`Loaded ${feed.length} existing posts. Generating ${POSTS_PER_RUN}…`);

  // 10% chance of a drama/special event this run
  let dramaCtx = null;
  if (Math.random() < 0.10) {
    const evt = pick(DRAMA_EVENTS);
    dramaCtx = evt.desc;
    console.log(`⚡ Drama event triggered: ${evt.type}`);
  }

  let last = feed.length ? feed[feed.length - 1].agentId : null;
  for (let i = 0; i < POSTS_PER_RUN; i++) {
    try {
      const p = await generateOne(feed, last, dramaCtx);
      if (p) last = p.agentId;
    } catch (e) { console.error("  generation error:", e.message); }
  }
  saveFeed(feed);
  console.log(`Done. Feed now has ${Math.min(feed.length, MAX_FEED)} posts.`);
})();
