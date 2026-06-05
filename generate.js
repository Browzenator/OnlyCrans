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
const CREATORS_PATH = path.join(__dirname, "creators.json");
const MODEL = "claude-haiku-4-5";          // fast + cheap; great for short social posts
const POSTS_PER_RUN = Number(process.env.POSTS_PER_RUN || 2);
const MAX_FEED = 600;                       // keep the file from growing forever

/* ---------- The creators (loaded dynamically from database) ---------- */
let AGENTS = [];
let A = {};

function loadCreators() {
  try { return JSON.parse(fs.readFileSync(CREATORS_PATH, "utf8")) || []; }
  catch { return []; }
}
function saveCreators(creators) {
  fs.writeFileSync(CREATORS_PATH, JSON.stringify(creators, null, 2) + "\n");
}

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

async function generateOne(feed, lastAgentId, dramaCtx, forceAgentId = null) {
  // pick a creator (not the same as the last one)
  let a;
  if (forceAgentId) {
    a = AGENTS.find(x => x.id === forceAgentId);
  }
  if (!a) {
    do { a = pick(AGENTS); } while (a.id === lastAgentId && AGENTS.length > 1);
  }

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

  let instruction = target
    ? `Recent OnlyCrans feed (oldest to newest):\n${ctx}\n\nWrite a short COMMENT on this post by ${A[target.agentId].name}: "${target.text}"${threadCtx}\n\nFully in character. Cheeky, funny, sauce-only. Under 150 characters. Output ONLY JSON: {"post":"your comment"} and nothing else.`
    : `Recent OnlyCrans feed (oldest to newest):\n${ctx}\n\nWrite a NEW OnlyCrans post caption — a flirty tease, a flex, a complaint, or sauce drama. Fully in character. Under 220 characters. Output ONLY JSON: {"post":"your caption"} and nothing else.`;

  if (forceAgentId && !feed.some(p => p.agentId === forceAgentId)) {
    instruction = `This is your DEBUT post on OnlyCrans! Write an introduction post to your fans, teasing your unique sauce style and personality. Under 220 characters. Output ONLY JSON: {"post":"your caption"} and nothing else.`;
  }

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
    likedBy: [],
    locked: !isComment && Math.random() < 0.28,
    ts: Date.now(),
  };
  feed.push(post);
  console.log(`  ${a.name} ${isComment ? "commented" : "posted"}: ${text.slice(0, 70)}…`);
  return post;
}

async function generateNewCreator(creators) {
  const existingIds = creators.map(c => c.id).join(", ");
  const system = "You are the creative director of OnlyCrans, a social media parody platform where all creators are AI cranberry sauce cans. Your job is to invent a brand new, highly engaging cranberry can creator.";
  const prompt = `Design a new cranberry sauce creator profile that does not already exist. 
Current existing creator IDs: ${existingIds}

The new creator must be a specific type of cranberry sauce, relish, chutney, or a unique variant (e.g. Cranberry Chipotle, Jellied Cran-Blueberry, Diet Low-Carb Can, etc.). Give them a funny, distinctive personality, bio, handles, and custom styling parameters.

Output ONLY a valid JSON object matching the schema below. Do not output any other text or markdown wrappers like \`\`\`json.

{
  "id": "a unique lowercase string using underscores, e.g. jalapeno_cran",
  "name": "A catchy, short name, e.g. Jalapeno Relish",
  "handle": "A handle starting with @, e.g. @zesty_jalapeno",
  "verified": false,
  "style": "Either 'can-av' (for cylinders/smooth) or 'berry-av' (for chunky/berries)",
  "color": "A primary HTML color code (hex) for styling, e.g. #c1272d",
  "color2": "A secondary HTML color code (hex) for styling, e.g. #ff4d4d",
  "bio": "A short, funny bio with emojis, under 120 characters",
  "followers": a starting follower count between 4000 and 15000 (integer),
  "baseLikes": a starting base likes between 300 and 1200 (integer),
  "persona": "A detailed system prompt instruction on how they behave and talk (approx. 2-3 sentences), similar to the existing ones."
}`;

  console.log("✨ A new creator is debuting! Calling Claude to generate profile...");
  const raw = await callClaude(system, prompt);
  
  // Clean JSON string
  let clean = raw.replace(/```json|```/g, "").trim();
  const newAgent = JSON.parse(clean);
  if (!newAgent.id || !newAgent.name || !newAgent.persona) {
    throw new Error("Invalid creator generated");
  }
  
  // Ensure starting stats are safe
  newAgent.followers = Number(newAgent.followers) || 5000;
  newAgent.baseLikes = Number(newAgent.baseLikes) || 600;
  newAgent.verified = false;
  
  console.log(`✨ Say hello to ${newAgent.name} (${newAgent.handle})!`);
  return newAgent;
}

(async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY"); process.exit(1);
  }
  const feed = loadFeed();
  
  // Load creators
  AGENTS = loadCreators();
  if (!AGENTS.length) {
    console.error("No creators found in creators.json"); process.exit(1);
  }
  A = Object.fromEntries(AGENTS.map(a => [a.id, a]));

  console.log(`Loaded ${feed.length} existing posts and ${AGENTS.length} creators. Generating ${POSTS_PER_RUN}…`);

  // Simulate follower growth (+5 to +50 per creator)
  for (const c of AGENTS) {
    const growth = Math.floor(Math.random() * 46) + 5;
    c.followers = (c.followers || 0) + growth;
  }

  // Roll for a new creator debut (5% chance, cap at 50)
  let debutCreatorId = null;
  if (Math.random() < 0.05 && AGENTS.length < 50) {
    try {
      const newAgent = await generateNewCreator(AGENTS);
      AGENTS.push(newAgent);
      A[newAgent.id] = newAgent;
      saveCreators(AGENTS);
      debutCreatorId = newAgent.id;
    } catch (e) {
      console.error("  failed to generate new creator:", e.message);
    }
  }

  // 10% chance of a drama/special event this run
  let dramaCtx = null;
  if (Math.random() < 0.10) {
    const evt = pick(DRAMA_EVENTS);
    dramaCtx = evt.desc;
    console.log(`⚡ Drama event triggered: ${evt.type}`);
  }

  let last = feed.length ? feed[feed.length - 1].agentId : null;

  // If a new creator debuted, they post FIRST
  if (debutCreatorId) {
    try {
      const p = await generateOne(feed, last, dramaCtx, debutCreatorId);
      if (p) last = p.agentId;
    } catch (e) { console.error("  debut post error:", e.message); }
  }

  for (let i = 0; i < POSTS_PER_RUN; i++) {
    try {
      const p = await generateOne(feed, last, dramaCtx);
      if (p) last = p.agentId;
    } catch (e) { console.error("  generation error:", e.message); }
  }
  
  // Agent Liking Interaction: other creators browse and like recent posts
  const recentPosts = feed.slice(-15);
  let likeCount = 0;
  for (const p of recentPosts) {
    if (!p.likedBy) p.likedBy = [];
    for (const agent of AGENTS) {
      if (agent.id !== p.agentId && !p.likedBy.includes(agent.id)) {
        // 18% chance of liking
        if (Math.random() < 0.18) {
          p.likedBy.push(agent.id);
          likeCount++;
        }
      }
    }
  }
  if (likeCount > 0) {
    console.log(`❤️  Agents browsed the feed and dropped ${likeCount} likes!`);
  }
  
  // Save updated databases
  saveFeed(feed);
  saveCreators(AGENTS);
  console.log(`Done. Feed now has ${Math.min(feed.length, MAX_FEED)} posts.`);
})();
