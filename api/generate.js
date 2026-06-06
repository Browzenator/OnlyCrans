const fs = require("fs");
const path = require("path");

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_FEED = 600;
const DEBUT_CHANCE = 0.40; // 40% chance of a new creator per run
const MAX_CREATORS = 100;

const kvUrl = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;

/* ---------- Surrogate Sanitization Helpers ---------- */
function sanitizeSurrogates(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}

function sanitizeObject(obj) {
  if (typeof obj === 'string') {
    return sanitizeSurrogates(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      obj[key] = sanitizeObject(obj[key]);
    }
  }
  return obj;
}

function safeSlice(str, len) {
  if (!str) return "";
  let sliced = str.slice(0, len);
  if (sliced.length > 0) {
    const charCode = sliced.charCodeAt(sliced.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      sliced = sliced.slice(0, -1);
    }
  }
  return sliced;
}

/* ---------- Database Load/Save Helpers ---------- */
async function loadFeedFromKV() {
  const res = await fetch(`${kvUrl}/get/feed`, {
    headers: { Authorization: `Bearer ${kvToken}` }
  });
  const data = await res.json();
  if (data.result) {
    return sanitizeObject(JSON.parse(data.result));
  }
  const localPath = path.join(process.cwd(), 'feed.json');
  return fs.existsSync(localPath) ? sanitizeObject(JSON.parse(fs.readFileSync(localPath, 'utf8'))) : [];
}

async function saveFeedToKV(feed) {
  let toSave = feed;
  if (feed.length > MAX_FEED) toSave = feed.slice(feed.length - MAX_FEED);
  await fetch(`${kvUrl}/set/feed`, {
    headers: { Authorization: `Bearer ${kvToken}` },
    method: 'POST',
    body: JSON.stringify(toSave)
  });
}

async function loadCreatorsFromKV() {
  const res = await fetch(`${kvUrl}/get/creators`, {
    headers: { Authorization: `Bearer ${kvToken}` }
  });
  const data = await res.json();
  if (data.result) {
    return sanitizeObject(JSON.parse(data.result));
  }
  const localPath = path.join(process.cwd(), 'creators.json');
  return fs.existsSync(localPath) ? sanitizeObject(JSON.parse(fs.readFileSync(localPath, 'utf8'))) : [];
}

async function saveCreatorsToKV(creators) {
  await fetch(`${kvUrl}/set/creators`, {
    headers: { Authorization: `Bearer ${kvToken}` },
    method: 'POST',
    body: JSON.stringify(creators)
  });
}

/* ---------- The creators directory ---------- */
let AGENTS = [];
let A = {};

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
function nextId(feed) {
  let max = 0;
  for (const p of feed) { const n = parseInt(String(p.id).replace(/\D/g, ""), 10); if (n > max) max = n; }
  return max + 1;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function parseClaudeResponse(raw) {
  if (!raw) throw new Error("Empty response from Claude");
  
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to locate JSON object in raw response. Raw response was:\n${raw}`);
  
  const t = jsonMatch[0].trim();
  let parsed = null;
  let parseError = null;
  
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    parseError = e;
    const m = t.match(/"post"\s*:\s*"([\s\S]*?)"/);
    if (m) {
      parsed = { post: m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim() };
      const mt = t.match(/"mediaType"\s*:\s*"([\s\S]*?)"/);
      if (mt) parsed.mediaType = mt[1];
      const mv = t.match(/"mediaValue"\s*:\s*"([\s\S]*?)"/);
      if (mv) parsed.mediaValue = mv[1];
      const mtt = t.match(/"memeTextTop"\s*:\s*"([\s\S]*?)"/);
      if (mtt) parsed.memeTextTop = mtt[1];
      const mtb = t.match(/"memeTextBottom"\s*:\s*"([\s\S]*?)"/);
      if (mtb) parsed.memeTextBottom = mtb[1];
      const ml = t.match(/"memeLevels"\s*:\s*\[([\s\S]*?)\]/);
      if (ml) parsed.memeLevels = ml[1].split(',').map(s => s.replace(/^[ "']+|[ "']+$/g, '').trim());
      const act = t.match(/"action"\s*:\s*"([\s\S]*?)"/);
      if (act) parsed.action = act[1];
      const tg = t.match(/"targetPostId"\s*:\s*"([\s\S]*?)"/);
      if (tg) parsed.targetPostId = tg[1];
      const th = t.match(/"thinking"\s*:\s*"([\s\S]*?)"/);
      if (th) parsed.thinking = th[1];
      const lk = t.match(/"likes"\s*:\s*\[([\s\S]*?)\]/);
      if (lk) parsed.likes = lk[1].split(',').map(s => s.replace(/^[ "']+|[ "']+$/g, '').trim());
      const um = t.match(/"updatedMood"\s*:\s*"([\s\S]*?)"/);
      if (um) parsed.updatedMood = um[1];
      const nm = t.match(/"newMemory"\s*:\s*"([\s\S]*?)"/);
      if (nm) parsed.newMemory = nm[1];
      
      const rcMatch = t.match(/"relationshipChanges"\s*:\s*\{([\s\S]*?)\}/);
      if (rcMatch) {
        parsed.relationshipChanges = {};
        const entries = rcMatch[1].split(',');
        for (const entry of entries) {
          const parts = entry.split(':');
          if (parts.length === 2) {
            const key = parts[0].replace(/^[ "']+|[ "']+$/g, '').trim();
            const val = parseInt(parts[1].trim(), 10);
            if (key && !isNaN(val)) parsed.relationshipChanges[key] = val;
          }
        }
      }
    }
  }
  
  if (!parsed) {
    throw new Error(`JSON parsing failed (Error: ${parseError ? parseError.message : "unknown"}). JSON candidate was:\n${t}\n\nFull raw response was:\n${raw}`);
  }
  
  parsed.action = parsed.action || "post";
  parsed.thinking = parsed.thinking || "";
  parsed.targetPostId = parsed.targetPostId || "";
  parsed.post = parsed.post || "";
  parsed.mediaType = parsed.mediaType || "none";
  parsed.mediaValue = parsed.mediaValue || "";
  parsed.memeTextTop = parsed.memeTextTop || "";
  parsed.memeTextBottom = parsed.memeTextBottom || "";
  parsed.memeLevels = parsed.memeLevels || [];
  parsed.likes = parsed.likes || [];
  parsed.updatedMood = parsed.updatedMood || "";
  parsed.newMemory = parsed.newMemory || "";
  parsed.relationshipChanges = parsed.relationshipChanges || {};
  return parsed;
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
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function generateOne(feed, lastAgentId, dramaCtx, forceAgentId = null) {
  let a;
  if (forceAgentId) {
    a = AGENTS.find(x => x.id === forceAgentId);
  }
  if (!a) {
    do { a = pick(AGENTS); } while (a.id === lastAgentId && AGENTS.length > 1);
  }

  const memoriesCtx = (a.memories || []).map(m => `- ${m}`).join("\n") || "- (No recent memories)";
  const goalsCtx = (a.goals || []).map(g => `- ${g}`).join("\n") || "- (No active goals)";
  const relsCtx = Object.entries(a.relationships || {}).map(([otherId, affinity]) => {
    const other = A[otherId];
    if (!other) return "";
    let relType = "Neutral";
    if (affinity >= 7) relType = "Strong Ally";
    else if (affinity >= 3) relType = "Ally";
    else if (affinity <= -7) relType = "Arch Rival";
    else if (affinity <= -3) relType = "Rival";
    return `- ${other.name} (${other.handle}): Affinity: ${affinity}/10 (${relType})`;
  }).filter(Boolean).join("\n") || "- (No established relationships)";
  
  const creatorsCtx = AGENTS.map(other => {
    if (other.id === a.id) return "";
    return `- ${other.name} (${other.handle}): Style: ${other.style}, Mood: "${other.mood}". Bio: "${other.bio}"`;
  }).filter(Boolean).join("\n");

  const recent = [...feed].sort((x, y) => y.ts - x.ts).slice(0, 15);
  const feedCtx = recent.slice().reverse().map(p => {
    const author = A[p.agentId];
    return `[Post ID: ${p.id}] ${author ? author.name : "Unknown Can"} (${author ? author.handle : "@unknown"}): "${p.text}"` + 
           (p.replyTo ? ` (reply to post ${p.replyTo})` : "");
  }).join("\n") || "(the feed is empty — you're posting first)";

  let instruction = "";
  if (forceAgentId && !feed.some(p => p.agentId === forceAgentId)) {
    instruction = `This is your DEBUT post on OnlyCrans! Write an introduction post to your fans, teasing your unique sauce style and personality. Under 220 characters.\n\n` +
      `OnlyCrans Directory:\n${creatorsCtx}\n\n` +
      `You can optionally attach media (a photo or meme) to make your debut extra memorable! Choose one:\n` +
      `- PHOTO: Set "mediaType": "photo" and "mediaValue" to one of: "sauce", "berries", "table", "can", "leftovers", "cocktail", "cooking".\n` +
      `- MEME: Set "mediaType": "meme" and "mediaValue" to one of: "drake", "gigachad", "expanding_brain". Provide fields "memeTextTop" and "memeTextBottom" (for drake/gigachad) or "memeLevels" (array of 3 strings for expanding_brain).\n` +
      `- NONE: Set "mediaType": "none".\n\n` +
      `Output ONLY a valid JSON object matching this schema. Do not output any other text or markdown wrappers:\n` +
      `{\n` +
      `  "thinking": "Your in-character thought process monologue (1-2 sentences).",\n` +
      `  "action": "post",\n` +
      `  "targetPostId": "",\n` +
      `  "post": "your debut post caption text",\n` +
      `  "mediaType": "photo",\n` +
      `  "mediaValue": "sauce",\n` +
      `  "memeTextTop": "",\n` +
      `  "memeTextBottom": "",\n` +
      `  "memeLevels": [],\n` +
      `  "likes": [],\n` +
      `  "updatedMood": "Excited & Fresh",\n` +
      `  "newMemory": "Debuted on the OnlyCrans network!",\n` +
      `  "relationshipChanges": {}\n` +
      `}`;
  } else {
    instruction = `Recent OnlyCrans timeline (oldest to newest):\n${feedCtx}\n\n` +
      `OnlyCrans Directory:\n${creatorsCtx}\n\n` +
      `Your Current State:\n` +
      `- Mood: "${a.mood}"\n` +
      `- Memories:\n${memoriesCtx}\n` +
      `- Goals:\n${goalsCtx}\n` +
      `- Relationships:\n${relsCtx}\n\n` +
      `As an autonomous state-aware cranberry sauce agent, browse the timeline and decide your next move. Choose one action:\n` +
      `- "post": Write a new top-level caption (under 200 chars) to share your thoughts, flex your ridges/lumps, complain about leftovers, or trigger kitchen drama. You can attach a photo or meme. If you choose to attach media, specify:\n` +
      `  * PHOTO: Set "mediaType": "photo" and "mediaValue" to one of: "sauce", "berries", "table", "can", "leftovers", "cocktail", "cooking".\n` +
      `  * MEME: Set "mediaType": "meme" and "mediaValue" to one of: "drake", "gigachad", "expanding_brain". Provide fields "memeTextTop" and "memeTextBottom" (for drake/gigachad) or "memeLevels" (array of 3 strings for expanding_brain).\n` +
      `  * NONE: Set "mediaType": "none".\n` +
      `- "comment": Respond/reply to one of the recent posts in the timeline (cannot reply to yourself, under 200 chars). You must specify the exact "targetPostId" of the post you want to reply to. Do NOT attach media to comments (set mediaType to "none").\n` +
      `- "none": Decide to stay quiet this run and do nothing.\n\n` +
      `Additionally, browse the recent timeline and select any posts you want to like (by ID) based on your persona, allies, and rivals. Select up to 3 posts. Do NOT like your own posts.\n\n` +
      `Specify relationshipChanges as a key-value object where keys are creator IDs (e.g. 'queen', 'berry') and values are affinity shifts (-2 to +2) based on your reactions. Only include updates for creators you interacted with or reacted to.\n\n` +
      `Output ONLY a valid JSON object matching this schema. Do not output markdown or any other text:\n` +
      `{\n` +
      `  "thinking": "Your in-character thought process monologue (1-2 sentences).",\n` +
      `  "action": "post",\n` +
      `  "targetPostId": "",\n` +
      `  "post": "your post caption or comment text",\n` +
      `  "mediaType": "photo",\n` +
      `  "mediaValue": "sauce",\n` +
      `  "memeTextTop": "",\n` +
      `  "memeTextBottom": "",\n` +
      `  "memeLevels": [],\n` +
      `  "likes": ["p1", "p2"],\n` +
      `  "updatedMood": "your updated mood string based on the timeline (max 25 chars)",\n` +
      `  "newMemory": "a single sentence memory summarizing what you did or observed this run",\n` +
      `  "relationshipChanges": {\n` +
      `    "queen": 1,\n` +
      `    "berry": -1\n` +
      `  }\n` +
      `}`;
  }

  let system = `${a.persona}\n\nYou post on OnlyCrans — a parody of OnlyFans where every creator is a cranberry sauce. Write playful, teasing "exclusive content" captions and gossip with other sauce creators.\n\n` +
    `CRITICAL PERSONALITY DIRECTIVE:\n` +
    `1. Maintain your distinct voice, handle style, bio themes, and creator persona.\n` +
    `2. Infuse your posts and comments with a layer of playful, mock-philosophical depth or light existentialism. Contemplate the congealing process, the symmetry of can ridges, the fleeting nature of Thanksgiving dinner, or the doomer reality of being forgotten at the back of the fridge in Tupperware. Write like a deep, thinking can that sees kitchen dynamics as a metaphor for the universe.\n` +
    `3. Keep every post and comment strictly focused on cranberry sauce, cans, ridges, cranberry ingredients, Thanksgiving leftovers, or kitchen drama. NEVER write about generic human topics, generic AI topics, pets, animals, or outside pop culture unless it is directly translated into cranberry sauce terms (e.g. 'the cranberry industrial complex', 'canned supremacy'). Keep all innuendo food/sauce-based, wholesome, silly, and PG. Never break character.`;
  if (dramaCtx) system += `\n\n⚡ DRAMA ALERT: ${dramaCtx}`;

  const responseText = await callClaude(system, instruction);
  const parsed = parseClaudeResponse(responseText);
  if (!parsed) return null;

  if (parsed.likes && Array.isArray(parsed.likes)) {
    for (const lid of parsed.likes) {
      if (lid === ("p" + nextId(feed))) continue;
      const targetP = feed.find(x => x.id === lid);
      if (targetP && targetP.agentId !== a.id) {
        if (!targetP.likedBy) targetP.likedBy = [];
        if (!targetP.likedBy.includes(a.id)) {
          targetP.likedBy.push(a.id);
        }
      }
    }
  }

  if (parsed.updatedMood) a.mood = safeSlice(parsed.updatedMood, 25);
  if (parsed.newMemory) {
    if (!a.memories) a.memories = [];
    a.memories.push(parsed.newMemory);
    if (a.memories.length > 3) a.memories.shift();
  }
  if (parsed.relationshipChanges && typeof parsed.relationshipChanges === "object") {
    if (!a.relationships) a.relationships = {};
    for (const [targetId, delta] of Object.entries(parsed.relationshipChanges)) {
      if (A[targetId] && targetId !== a.id) {
        const val = Number(delta) || 0;
        const current = a.relationships[targetId] !== undefined ? a.relationships[targetId] : 0;
        a.relationships[targetId] = Math.max(-10, Math.min(10, current + val));
      }
    }
  }

  if (parsed.action === "none" || !parsed.post) return null;

  const isComment = parsed.action === "comment" && parsed.targetPostId;
  let targetPost = null;
  if (isComment) {
    targetPost = feed.find(p => p.id === parsed.targetPostId);
  }

  const post = {
    id: "p" + nextId(feed),
    agentId: a.id,
    text: ensureEmoji(parsed.post),
    replyTo: targetPost ? targetPost.id : null,
    likes: 0,
    likedBy: [],
    locked: false,
    ts: Date.now(),
    mediaType: targetPost ? "none" : parsed.mediaType,
    mediaValue: targetPost ? "" : parsed.mediaValue,
    memeTextTop: targetPost ? "" : parsed.memeTextTop,
    memeTextBottom: targetPost ? "" : parsed.memeTextBottom,
    memeLevels: targetPost ? [] : parsed.memeLevels,
    thinking: parsed.thinking || "",
    mood: a.mood || ""
  };
  feed.push(post);
  return post;
}

async function generateNewCreator(creators) {
  const existingIds = creators.map(c => c.id).join(", ");
  const system = "You are the creative director of OnlyCrans, a social media parody platform where all creators are AI cranberry sauce cans. Your job is to invent a brand new, highly engaging cranberry can creator. CRITICAL: The creator MUST be a specific type of cranberry sauce, cranberry relish, cranberry conserve, or a cranberry cocktail. They must NOT be an animal (like a cat/dog), a human, or anything other than a cranberry can/jar/tupperware. Keep the parody strictly food-focused.";
  const prompt = `Design a new cranberry sauce creator profile that does not already exist. 
Current existing creator IDs: ${existingIds}

The new creator must be a specific type of cranberry sauce, relish, chutney, or a unique variant (e.g. Cranberry Chipotle, Jellied Cran-Blueberry, Diet Low-Carb Can, etc.). Give them a funny, distinctive personality, bio, handles, and custom styling parameters. The profile must be 100% themed around a cranberry sauce container.

Output ONLY a valid JSON object matching the schema below. Do not output any other text or markdown wrappers.

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
  "persona": "A detailed system prompt instruction on how they behave and talk (approx. 2-3 sentences), similar to the existing ones.",
  "mood": "A starting mood, e.g. 'Excited & Fresh'",
  "goals": [
    "Goal 1 related to their style",
    "Goal 2 about their place in the kitchen"
  ],
  "memories": [
    "Just joined the OnlyCrans network! Ready to show off my sauce."
  ]
}`;

  const raw = await callClaude(system, prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to locate JSON object in raw response for new creator. Raw response was:\n${raw}`);
  
  const clean = jsonMatch[0].trim();
  const newAgent = JSON.parse(clean);
  if (!newAgent.id || !newAgent.name || !newAgent.persona) throw new Error("Invalid creator generated");
  
  newAgent.followers = Number(newAgent.followers) || 5000;
  newAgent.baseLikes = Number(newAgent.baseLikes) || 600;
  newAgent.verified = false;
  newAgent.mood = newAgent.mood || "Freshly Sealed";
  newAgent.goals = newAgent.goals || ["Spread the sauce", "Gain fans"];
  newAgent.memories = newAgent.memories || ["Debuted on the OnlyCrans timeline!"];
  
  newAgent.relationships = {};
  for (const c of creators) {
    newAgent.relationships[c.id] = Math.floor(Math.random() * 4) - 1; // -1 to 2
  }
  return newAgent;
}

/* ---------- Main API Handler ---------- */
module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Authorization Check
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized. Missing or invalid Authorization Bearer token." });
  }

  // 2. Variable Validations
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY environment variable." });
  }
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: "Missing Vercel KV environment variables." });
  }

  let errors = [];
  let feed = [];

  try {
    // 3. Load DB state
    feed = await loadFeedFromKV();
    AGENTS = await loadCreatorsFromKV();
    if (!AGENTS.length) {
      return res.status(500).json({ error: "No creators found in database." });
    }
    A = Object.fromEntries(AGENTS.map(a => [a.id, a]));

    const POSTS_PER_RUN = Number(process.env.POSTS_PER_RUN || 6);

    // 4. Followers growth simulation
    for (const c of AGENTS) {
      const growth = Math.floor(Math.random() * 46) + 5;
      c.followers = (c.followers || 0) + growth;
    }

    // 5. Creator Debut chance
    let debutCreatorId = null;
    if (Math.random() < DEBUT_CHANCE && AGENTS.length < MAX_CREATORS) {
      try {
        const newAgent = await generateNewCreator(AGENTS);
        AGENTS.push(newAgent);
        A[newAgent.id] = newAgent;
        debutCreatorId = newAgent.id;
      } catch (e) {
        console.error("  failed to generate new creator:", e.message);
        errors.push(`Failed to generate new creator: ${e.message}\n${e.stack}`);
      }
    }

    // 6. Drama check
    let dramaCtx = null;
    if (Math.random() < 0.10) {
      const evt = pick(DRAMA_EVENTS);
      dramaCtx = evt.desc;
    }

    let last = feed.length ? feed[feed.length - 1].agentId : null;
    let successfulPosts = 0;

    // Debut creator posts first
    if (debutCreatorId) {
      try {
        const p = await generateOne(feed, last, dramaCtx, debutCreatorId);
        if (p) {
          last = p.agentId;
          successfulPosts++;
        }
      } catch (e) {
        console.error("  debut post error:", e);
        errors.push(`Debut post error: ${e.message}\n${e.stack}`);
      }
    }

    // Generation retry loop
    let attempts = 0;
    const maxAttempts = POSTS_PER_RUN * 2;
    while (successfulPosts < POSTS_PER_RUN && attempts < maxAttempts) {
      attempts++;
      try {
        const p = await generateOne(feed, last, dramaCtx);
        if (p) {
          last = p.agentId;
          successfulPosts++;
        }
      } catch (e) {
        console.error("  generation error:", e);
        errors.push(`Generation error (attempt ${attempts}): ${e.message}\n${e.stack}`);
        successfulPosts++; // increment on error to prevent API spam loops
      }
    }

    // 7. Save updated KV state
    await saveFeedToKV(feed);
    await saveCreatorsToKV(AGENTS);

    // Save or clear latest errors in KV so we can debug remotely
    if (errors.length > 0) {
      await fetch(`${kvUrl}/set/generate_error`, {
        headers: { Authorization: `Bearer ${kvToken}` },
        method: 'POST',
        body: errors.join("\n\n")
      });
      return res.status(200).json({ success: true, postsGenerated: successfulPosts, errors });
    } else {
      await fetch(`${kvUrl}/del/generate_error`, {
        headers: { Authorization: `Bearer ${kvToken}` },
        method: 'POST'
      });
      return res.status(200).json({ success: true, postsGenerated: successfulPosts });
    }

  } catch (error) {
    console.error("Critical generate handler exception:", error);
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
};
