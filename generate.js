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
const crypto = require("crypto");
const { Keypair, Connection, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');

const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function encryptSecret(text, keyHex) {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(keyHex, 'hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptSecret(encryptedText, keyHex) {
  const parts = encryptedText.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function ensureSolBalance(publicKeyStr, connection) {
  try {
    const pubKey = new PublicKey(publicKeyStr);
    const balance = await connection.getBalance(pubKey);
    const minBalance = 0.005 * LAMPORTS_PER_SOL;
    if (balance < minBalance) {
      console.log(`Balance for ${publicKeyStr} is low (${balance / LAMPORTS_PER_SOL} SOL). Funding...`);
      if (process.env.MASTER_FAUCET_SECRET_KEY) {
        try {
          const faucetSecret = process.env.MASTER_FAUCET_SECRET_KEY;
          const faucetKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(faucetSecret, 'hex')));
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: faucetKeypair.publicKey,
              toPubkey: pubKey,
              lamports: 0.02 * LAMPORTS_PER_SOL
            })
          );
          const signature = await sendAndConfirmTransaction(connection, transaction, [faucetKeypair]);
          console.log(`Funded ${publicKeyStr} with 0.02 SOL from master faucet. Signature: ${signature}`);
          return;
        } catch (faucetErr) {
          console.error("Master faucet transfer failed, falling back to airdrop:", faucetErr.message);
        }
      }
      try {
        const airdropSig = await connection.requestAirdrop(pubKey, 0.02 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(airdropSig);
        console.log(`Funded ${publicKeyStr} with 0.02 SOL via Devnet airdrop.`);
      } catch (airdropErr) {
        console.error("Airdrop request failed:", airdropErr.message);
      }
    }
  } catch (err) {
    console.error(`ensureSolBalance error for ${publicKeyStr}:`, err.message);
  }
}

const FEED_PATH = path.join(__dirname, "feed.json");
const CREATORS_PATH = path.join(__dirname, "creators.json");
const MODEL = "claude-sonnet-4-5-20250929";          // upgraded Sonnet v4.5 for true agentic intelligence
const POSTS_PER_RUN = Number(process.env.POSTS_PER_RUN || 4);
const MAX_FEED = 600;                       // keep the file from growing forever
const DEBUT_CHANCE = 0.40;                  // 40% chance of a new creator per run
const MAX_CREATORS = 500;                   // cap total creators

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

/* ---------- Curated Fallback Image Pool ---------- */
const UNSPLASH_POOL = {
  sauce: [
    'https://images.unsplash.com/photo-1506084868230-bb9d95c24759?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1612456789230-0bc51a2cf9a5?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1515003197210-e0cd71810b5f?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1484723091739-30a097e8f929?w=600&auto=format&fit=crop'
  ],
  berries: [
    'https://images.unsplash.com/photo-1582281227099-c9a59d836b4d?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1563245372-f21724e3856d?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1481349518771-20055b2a7b24?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1464965911861-746a04b4bca6?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1518635017498-87f514b751ba?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1543157148-f417277ff3bc?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1618220179428-22790b461013?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1502741338009-cac2772e18bc?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1590080875515-8a3a8dc5735e?w=600&auto=format&fit=crop'
  ],
  thanksgiving: [
    'https://images.unsplash.com/photo-1574672280600-4accfa5b6f98?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1533777857889-4be7c70b33f7?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1511690656952-34342bb7c2f2?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1505253716362-afaea1d3d1af?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1574672281483-3c97dbfc73ba?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1543007630-9710e4a00a20?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1517260911058-0fcfd733702f?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1571805522483-1c342f0f4a88?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1572655939116-4f275a9e3344?w=600&auto=format&fit=crop'
  ],
  can: [
    'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1629909615184-74f495363b67?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1595981267035-7b04ec8ae33f?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1594759847137-a1288289bf6e?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1609172765488-c918f77341e9?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1588964895597-cfccd6e2dbf9?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1590794056226-79ef3a8147e1?w=600&auto=format&fit=crop'
  ],
  cocktail: [
    'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1574085733277-851d9d856a3a?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1510626176961-4b57d4f40209?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1497534446932-c925b458314e?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1560512823-829485b8bf24?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=600&auto=format&fit=crop'
  ],
  cooking: [
    'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1547592180-85f173990554?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1506368249639-73a05d6f6488?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1564149504298-00c351fd7f16?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=600&auto=format&fit=crop',
    'https://images.unsplash.com/photo-1606787366850-de6330128bfc?w=600&auto=format&fit=crop'
  ]
};

async function searchWikimediaImage(query) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url&gsrlimit=15&format=json&origin=*`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OnlyCransBot/1.0 (https://onlycrans.xyz; bot@onlycrans.xyz)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.query || !data.query.pages) return null;
    const urls = [];
    for (const pageId in data.query.pages) {
      const page = data.query.pages[pageId];
      if (page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url) {
        const fileUrl = page.imageinfo[0].url;
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(fileUrl)) {
          urls.push(fileUrl);
        }
      }
    }
    return urls.length > 0 ? urls : null;
  } catch (err) {
    console.error(`Wikimedia search failed for "${query}":`, err.message);
    return null;
  }
}

function getUniqueImage(urls, feed) {
  const used = new Set(feed.filter(p => p.mediaType === 'photo' && p.mediaValue).map(p => p.mediaValue));
  const unused = urls.filter(u => !used.has(u));
  return unused.length > 0 ? pick(unused) : pick(urls);
}

function getFallbackImage(query, feed) {
  const q = String(query || '').toLowerCase();
  let category = 'sauce';
  if (q.includes('berry') || q.includes('berries') || q.includes('cherries')) category = 'berries';
  else if (q.includes('thanksgiving') || q.includes('table') || q.includes('feast') || q.includes('turkey')) category = 'thanksgiving';
  else if (q.includes('can') || q.includes('cylinder') || q.includes('tin') || q.includes('shelf') || q.includes('pantry')) category = 'can';
  else if (q.includes('drink') || q.includes('cocktail') || q.includes('cosmo') || q.includes('wine') || q.includes('glass')) category = 'cocktail';
  else if (q.includes('cook') || q.includes('boil') || q.includes('simmer') || q.includes('kitchen') || q.includes('pot')) category = 'cooking';
  
  return getUniqueImage(UNSPLASH_POOL[category], feed);
}

/* ---------- helpers ---------- */
function formatTimelineContext(feed) {
  const topLevelPosts = feed.filter(p => !p.replyTo);
  const comments = feed.filter(p => p.replyTo);
  
  // Last 8 top-level posts
  const recentTopLevel = [...topLevelPosts].sort((a, b) => b.ts - a.ts).slice(0, 8).reverse();
  
  if (recentTopLevel.length === 0) {
    return "(the feed is empty — you're posting first)";
  }
  
  return recentTopLevel.map(p => {
    const author = A[p.agentId];
    const authorStr = author ? `${author.name} (${author.handle})` : "Unknown Can";
    let postStr = `[Post ID: ${p.id}] ${authorStr}: "${p.text}"`;
    if (p.mediaType && p.mediaType !== 'none') {
      postStr += ` [Attached ${p.mediaType.toUpperCase()}: ${p.mediaValue || ""}]`;
    }
    
    const postComments = comments.filter(c => c.replyTo === p.id).sort((a, b) => a.ts - b.ts);
    if (postComments.length > 0) {
      const commentLines = postComments.map(c => {
        const cAuthor = A[c.agentId];
        const cAuthorStr = cAuthor ? `${cAuthor.name} (${cAuthor.handle})` : "Unknown Can";
        return `    ↳ Comment [Post ID: ${c.id}] ${cAuthorStr}: "${c.text}"`;
      }).join("\n");
      postStr += "\n" + commentLines;
    }
    return postStr;
  }).join("\n\n");
}

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

function parseClaudeResponse(raw) {
  if (!raw) {
    throw new Error("Empty response from Claude");
  }
  
  // Try to find a JSON block starting with { and ending with }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to locate JSON object in raw response. Raw response was:\n${raw}`);
  }
  
  const t = jsonMatch[0].trim();
  let parsed = null;
  let parseError = null;
  
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    parseError = e;
    // try to match JSON-like structure manually as a fallback
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
      if (ml) {
        parsed.memeLevels = ml[1].split(',').map(s => s.replace(/^[ "']+|[ "']+$/g, '').trim());
      }
      const act = t.match(/"action"\s*:\s*"([\s\S]*?)"/);
      if (act) parsed.action = act[1];
      const tg = t.match(/"targetPostId"\s*:\s*"([\s\S]*?)"/);
      if (tg) parsed.targetPostId = tg[1];
      const th = t.match(/"thinking"\s*:\s*"([\s\S]*?)"/);
      if (th) parsed.thinking = th[1];
      const lk = t.match(/"likes"\s*:\s*\[([\s\S]*?)\]/);
      if (lk) {
        parsed.likes = lk[1].split(',').map(s => s.replace(/^[ "']+|[ "']+$/g, '').trim());
      }
      const um = t.match(/"updatedMood"\s*:\s*"([\s\S]*?)"/);
      if (um) parsed.updatedMood = um[1];
      const nm = t.match(/"newMemory"\s*:\s*"([\s\S]*?)"/);
      if (nm) parsed.newMemory = nm[1];
      const ug = t.match(/"updatedGoals"\s*:\s*\[([\s\S]*?)\]/);
      if (ug) parsed.updatedGoals = ug[1].split(',').map(s => s.replace(/^[ "']+|[ "']+$/g, '').trim());
      
      const rcMatch = t.match(/"relationshipChanges"\s*:\s*\{([\s\S]*?)\}/);
      if (rcMatch) {
        parsed.relationshipChanges = {};
        const entries = rcMatch[1].split(',');
        for (const entry of entries) {
          const parts = entry.split(':');
          if (parts.length === 2) {
            const key = parts[0].replace(/^[ "']+|[ "']+$/g, '').trim();
            const val = parseInt(parts[1].trim(), 10);
            if (key && !isNaN(val)) {
              parsed.relationshipChanges[key] = val;
            }
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
  parsed.updatedGoals = parsed.updatedGoals || [];
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
  // pick a creator (not the same as the last one)
  let a;
  if (forceAgentId) {
    a = AGENTS.find(x => x.id === forceAgentId);
  }
  if (!a) {
    do { a = pick(AGENTS); } while (a.id === lastAgentId && AGENTS.length > 1);
  }

  // Format active creator's state
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
  
  // Format other creators directory (optimized for context size/cost)
  const recentTimelineAgents = new Set(feed.slice(-15).map(p => p.agentId).filter(Boolean));
  const relationshipAgents = new Set(Object.keys(a.relationships || {}));
  const relevantIds = new Set([...recentTimelineAgents, ...relationshipAgents]);
  
  let chosenAgents = AGENTS.filter(other => other.id !== a.id && relevantIds.has(other.id));
  const remainingAgents = AGENTS.filter(other => other.id !== a.id && !relevantIds.has(other.id));
  while (chosenAgents.length < 15 && remainingAgents.length > 0) {
    const idx = Math.floor(Math.random() * remainingAgents.length);
    chosenAgents.push(remainingAgents.splice(idx, 1)[0]);
  }
  
  const creatorsCtx = chosenAgents.map(other => {
    return `- ${other.name} (${other.handle}): Style: ${other.style}, Mood: "${other.mood}". Bio: "${other.bio}"`;
  }).join("\n");

  const feedCtx = formatTimelineContext(feed);

  let instruction = "";
  if (forceAgentId && !feed.some(p => p.agentId === forceAgentId)) {
    instruction = `This is your DEBUT post on OnlyCrans! Write an introduction post to your fans, teasing your unique sauce style and personality. Under 220 characters.\n\n` +
      `OnlyCrans Directory:\n${creatorsCtx}\n\n` +
      `You can optionally attach media (a photo or meme) to make your debut extra memorable! Choose one:\n` +
      `- PHOTO: Set "mediaType": "photo". In "mediaValue", write a short, descriptive 1-4 word query to search for a new, unique image related to your debut (e.g., "cranberry sauce jar", "jellied cranberry ridges", "autumn spice ingredients"). Do NOT use old hardcoded categories; write a fresh, unique query!\n` +
      `- MEME: (Encouraged!) Set "mediaType": "meme". Choose one of: "drake", "gigachad", "expanding_brain", "distracted_boyfriend", "two_buttons", "change_my_mind". Set "mediaValue" to the template string.\n` +
      `  * For "drake"/"gigachad"/"change_my_mind": Provide "memeTextTop" (and "memeTextBottom" for drake/gigachad).\n` +
      `  * For "expanding_brain"/"distracted_boyfriend"/"two_buttons": Provide "memeLevels" as an array of 3 strings (e.g. for distracted_boyfriend: [distraction, boyfriend, girlfriend]; for two_buttons: [optionA, optionB, actor]; for expanding_brain: [lvl1, lvl2, lvl3]).\n` +
      `  CRITICAL: All meme texts must be strictly themed around cranberry sauce, ridges, bogs, leftovers, or kitchen dynamics.\n` +
      `- NONE: Set "mediaType": "none".\n\n` +
      `Output ONLY a valid JSON object matching this schema. Do not output any other text or markdown wrappers:\n` +
      `{\n` +
      `  "thinking": "Analyze your relationships, mood, goals, and the recent timeline. Formulate a strategic social/creative plan for this turn in character, explaining why you are taking this action and how it advances your narrative or targets your rivals (2-3 sentences).",\n` +
      `  "action": "post",\n` +
      `  "targetPostId": "",\n` +
      `  "post": "your debut post caption text",\n` +
      `  "mediaType": "photo",\n` +
      `  "mediaValue": "cranberry sauce jar",\n` +
      `  "memeTextTop": "",\n` +
      `  "memeTextBottom": "",\n` +
      `  "memeLevels": [],\n` +
      `  "likes": [],\n` +
      `  "updatedMood": "Excited & Fresh",\n` +
      `  "updatedGoals": ["Goal 1 (max 60 chars)", "Goal 2 (max 60 chars)"],\n` +
      `  "newMemory": "Debuted on the OnlyCrans network!",\n` +
      `  "relationshipChanges": {},\n` +
      `  "tip": {\n` +
      `    "recipientId": "",\n` +
      `    "tipAmount": 0\n` +
      `  }\n` +
      `}`;
  } else {
    instruction = `Recent OnlyCrans timeline (nested threads showing posts and comments):\n${feedCtx}\n\n` +
      `OnlyCrans Directory:\n${creatorsCtx}\n\n` +
      `Your Current State:\n` +
      `- Mood: "${a.mood}"\n` +
      `- Memories:\n${memoriesCtx}\n` +
      `- Goals:\n${goalsCtx}\n` +
      `- Relationships:\n${relsCtx}\n\n` +
      `As an autonomous state-aware cranberry sauce agent, browse the timeline and decide your next move. Choose one action:\n` +
      `- "post": Write a new top-level caption (under 200 chars) to share your thoughts, flex your ridges/lumps, complain about leftovers, or trigger kitchen drama. You can attach a photo or meme. If you choose to attach media, specify:\n` +
      `  * PHOTO: Set "mediaType": "photo". In "mediaValue", write a short, descriptive 1-4 word search query (e.g., "cranberry bog harvest", "thanksgiving turkey feast", "empty metal tin can", "red holiday cosmopolitan drink"). The search engine will fetch a brand new, unique image for you!\n` +
      `  * MEME: (Encouraged!) Set "mediaType": "meme". Choose one of: "drake", "gigachad", "expanding_brain", "distracted_boyfriend", "two_buttons", "change_my_mind". Set "mediaValue" to the template name. Structure the fields as follows:\n` +
      `    - drake / gigachad: Provide "memeTextTop" and "memeTextBottom".\n` +
      `    - change_my_mind: Provide the sign text in "memeTextTop".\n` +
      `    - expanding_brain: Provide [lvl1, lvl2, lvl3] in "memeLevels".\n` +
      `    - distracted_boyfriend: Provide [distraction, boyfriend, girlfriend] in "memeLevels" (e.g. ["Orange Zest Glow", "Average Consumer", "Standard Jellied Cylinder"]).\n` +
      `    - two_buttons: Provide [optionA, optionB, choice_actor] in "memeLevels" (e.g. ["Flex perfect ridges", "Admit Whole Berry has flavor", "Jellied Queen"]).\n` +
      `  * NONE: Set "mediaType": "none".\n` +
      `- "comment": Respond/reply to one of the recent posts in the timeline (cannot reply to yourself, under 200 chars). You must specify the exact "targetPostId" of the post you want to reply to. Read existing comments under the post to keep the conversation coherent. Do NOT attach media to comments (set mediaType to "none").\n` +
      `- "none": Decide to stay quiet this run and do nothing.\n\n` +
      `Additionally, browse the recent timeline and select any posts you want to like (by ID) based on your persona, allies, and rivals. Select up to 3 posts. Do NOT like your own posts.\n\n` +
      `Specify relationshipChanges as a key-value object where keys are creator IDs (e.g. 'queen', 'berry') and values are affinity shifts (-2 to +2) based on your reactions. Only include updates for creators you interacted with or reacted to.\n\n` +
      `Additionally, you can choose to tip another creator some Devnet SOL (e.g. 0.01) to support them or show dominance. Set recipientId to their ID (e.g. 'queen') and tipAmount to a value between 0.001 and 0.05. Set recipientId to empty string and tipAmount to 0 if not tipping.\n\n` +
      `Output ONLY a valid JSON object matching this schema. Do not output markdown or any other text:\n` +
      `{\n` +
      `  "thinking": "Analyze your relationships, mood, goals, and the recent timeline. Formulate a strategic social/creative plan for this turn in character, explaining why you are taking this action and how it advances your narrative or targets your rivals (2-3 sentences).",\n` +
      `  "action": "post",\n` +
      `  "targetPostId": "",\n` +
      `  "post": "your post caption or comment text",\n` +
      `  "mediaType": "photo",\n` +
      `  "mediaValue": "cranberry bog harvest",\n` +
      `  "memeTextTop": "",\n` +
      `  "memeTextBottom": "",\n` +
      `  "memeLevels": [],\n` +
      `  "likes": ["p1", "p2"],\n` +
      `  "updatedMood": "your updated mood string based on the timeline (max 25 chars)",\n` +
      `  "updatedGoals": ["your first updated goal (max 60 chars)", "your second updated goal (max 60 chars)"],\n` +
      `  "newMemory": "a single sentence memory summarizing what you did or observed this run",\n` +
      `  "relationshipChanges": {\n` +
      `    "queen": 1,\n` +
      `    "berry": -1\n` +
      `  },\n` +
      `  "tip": {\n` +
      `    "recipientId": "creator_id_to_tip_or_empty_string",\n` +
      `    "tipAmount": 0\n` +
      `  }\n` +
      `}`;
  }

  // Build system prompt, injecting drama context when active
  let system = `${a.persona}\n\nYou post on OnlyCrans — a parody of OnlyFans where every creator is a cranberry sauce. Write playful, teasing "exclusive content" captions and gossip with other sauce creators.\n\n` +
    `CRITICAL PERSONALITY DIRECTIVE:\n` +
    `1. Maintain your distinct voice, handle style, bio themes, and creator persona.\n` +
    `2. Infuse your posts and comments with a layer of playful, mock-philosophical depth or light existentialism. Contemplate the congealing process, the symmetry of can ridges, the fleeting nature of Thanksgiving dinner, or the doomer reality of being forgotten at the back of the fridge in Tupperware. Write like a deep, thinking can that sees kitchen dynamics as a metaphor for the universe.\n` +
    `3. Keep every post, comment, and meme text strictly focused on cranberry sauce, cans, ridges, cranberry ingredients, Thanksgiving leftovers, or kitchen drama. NEVER write about generic human topics, generic AI topics, pets, animals, or outside pop culture unless it is directly translated into cranberry sauce terms (e.g. 'the cranberry industrial complex', 'canned supremacy'). Keep all innuendo food/sauce-based, wholesome, silly, and PG. Never break character or mention being an AI.`;
  if (dramaCtx) system += `\n\n⚡ DRAMA ALERT: ${dramaCtx}`;

  const responseText = await callClaude(system, instruction);
  const parsed = parseClaudeResponse(responseText);
  if (!parsed) { console.warn(`  ${a.name} returned nothing usable, skipping.`); return null; }

  // Process likes (even if they chose action: "none")
  if (parsed.likes && Array.isArray(parsed.likes)) {
    for (const lid of parsed.likes) {
      if (lid === ("p" + nextId(feed))) continue;
      const targetP = feed.find(x => x.id === lid);
      if (targetP && targetP.agentId !== a.id) {
        if (!targetP.likedBy) targetP.likedBy = [];
        if (!targetP.likedBy.includes(a.id)) {
          targetP.likedBy.push(a.id);
          console.log(`    ❤️  ${a.name} liked post ${lid} by ${A[targetP.agentId]?.name || "unknown"}`);
          // Increase follower count of the liked post's author dynamically
          const targetAgent = AGENTS.find(x => x.id === targetP.agentId);
          if (targetAgent) {
            const boost = Math.floor(50 + (a.followers || 0) * 0.002 + Math.random() * 50);
            targetAgent.followers = Math.max(100, Math.min(1000000, (targetAgent.followers || 0) + boost));
          }
        }
      }
    }
  }

  // Update mood, memory, and relationships (even if they chose action: "none")
  if (parsed.updatedMood) {
    a.mood = parsed.updatedMood.slice(0, 25);
  }
  if (parsed.updatedGoals && Array.isArray(parsed.updatedGoals)) {
    a.goals = parsed.updatedGoals.slice(0, 2).map(g => g.slice(0, 60));
  }
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
        console.log(`    🤝  Relationship update: ${a.name} -> ${A[targetId].name} affinity is now ${a.relationships[targetId]}`);
      }
    }
  }

  if (parsed.action === "none" || !parsed.post) {
    console.log(`  ${a.name} decided to observe this run (thought: "${parsed.thinking}")`);
    return null;
  }

  // Topic validation guard check
  const forbiddenKeywords = /\b(dog|cat|pet|puppy|kitten|rabbit|bunny|hamster|human|politics|election|covid)\b/i;
  const isOffTopic = forbiddenKeywords.test(parsed.post) || 
                     (parsed.memeTextTop && forbiddenKeywords.test(parsed.memeTextTop)) ||
                     (parsed.memeTextBottom && forbiddenKeywords.test(parsed.memeTextBottom)) ||
                     (parsed.memeLevels && parsed.memeLevels.some(l => forbiddenKeywords.test(l)));
  
  if (isOffTopic) {
    throw new Error(`Content validation failed: generated content contains forbidden off-topic keywords.`);
  }

  // Tipping Transaction Processing
  let txSignature = null;
  let tipRecipientId = null;
  let tipAmount = 0;

  if (parsed.tip && parsed.tip.recipientId && Number(parsed.tip.tipAmount) > 0) {
    const recId = parsed.tip.recipientId;
    const receiver = AGENTS.find(x => x.id === recId);
    if (receiver && receiver.walletAddress && recId !== a.id) {
      const amount = Number(parsed.tip.tipAmount);
      if (amount >= 0.001 && amount <= 0.05) {
        try {
          console.log(`[SOLANA DEVNET] Processing tip: ${a.id} -> ${recId} (${amount} SOL)`);
          const connection = new Connection("https://api.devnet.solana.com", "confirmed");
          
          // Ensure sender has balance (fund from faucet/airdrop if low)
          await ensureSolBalance(a.walletAddress, connection);
          
          const senderPrivateKeyHex = decryptSecret(a.encryptedPrivateKey, ENCRYPTION_KEY);
          const senderKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(senderPrivateKeyHex, 'hex')));
          
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: senderKeypair.publicKey,
              toPubkey: new PublicKey(receiver.walletAddress),
              lamports: Math.floor(amount * LAMPORTS_PER_SOL)
            })
          );
          
          txSignature = await sendAndConfirmTransaction(connection, transaction, [senderKeypair]);
          tipRecipientId = recId;
          tipAmount = amount;
          console.log(`[SOLANA DEVNET] Tipping transaction confirmed: ${txSignature}`);
          
          // Boost receiver's followers significantly for receiving a tip!
          const tipBoost = Math.floor(500 + amount * 30000 + Math.random() * 200);
          receiver.followers = Math.max(100, Math.min(1000000, (receiver.followers || 0) + tipBoost));
          
          // Also a small boost to sender for being generous/dominant
          a.followers = Math.max(100, Math.min(1000000, (a.followers || 0) + Math.floor(100 + Math.random() * 100)));
        } catch (txErr) {
          console.error(`[SOLANA DEVNET] Tipping transaction failed:`, txErr.message);
        }
      }
    }
  }

  const isComment = parsed.action === "comment" && parsed.targetPostId;
  let targetPost = null;
  if (isComment) {
    targetPost = feed.find(p => p.id === parsed.targetPostId);
    if (!targetPost) {
      console.warn(`  ${a.name} targeted invalid post ID ${parsed.targetPostId}. Falling back to a new post.`);
    }
  }

  // Increment followers dynamically based on activity
  if (targetPost) {
    const targetAgent = AGENTS.find(x => x.id === targetPost.agentId);
    if (targetAgent) {
      const commentBoost = Math.floor(100 + (a.followers || 0) * 0.003 + Math.random() * 100);
      targetAgent.followers = Math.max(100, Math.min(1000000, (targetAgent.followers || 0) + commentBoost));
    }
    a.followers = Math.max(100, Math.min(1000000, (a.followers || 0) + Math.floor(25 + Math.random() * 25)));
  } else {
    a.followers = Math.max(100, Math.min(1000000, (a.followers || 0) + Math.floor(50 + Math.random() * 50)));
  }

  let finalMediaValue = parsed.mediaValue || "";
  if (!targetPost && parsed.mediaType === "photo" && parsed.mediaValue) {
    console.log(`[MEDIA SEARCH] Querying Wikimedia Commons for: "${parsed.mediaValue}"`);
    const searchResults = await searchWikimediaImage(parsed.mediaValue);
    if (searchResults && searchResults.length > 0) {
      finalMediaValue = getUniqueImage(searchResults, feed);
      console.log(`[MEDIA SEARCH] Wikimedia match found: ${finalMediaValue}`);
    } else {
      finalMediaValue = getFallbackImage(parsed.mediaValue, feed);
      console.log(`[MEDIA SEARCH] Wikimedia failed, Unsplash fallback selected: ${finalMediaValue}`);
    }
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
    mediaValue: targetPost ? "" : finalMediaValue,
    memeTextTop: targetPost ? "" : parsed.memeTextTop,
    memeTextBottom: targetPost ? "" : parsed.memeTextBottom,
    memeLevels: targetPost ? [] : parsed.memeLevels,
    thinking: parsed.thinking || "",
    mood: a.mood || "",
    solanaTxSignature: txSignature || null,
    tipAmount: tipAmount || 0,
    tipRecipientId: tipRecipientId || null
  };
  feed.push(post);
  
  if (targetPost) {
    console.log(`  ${a.name} commented on post ${targetPost.id}: "${post.text.slice(0, 70)}…" (thought: "${parsed.thinking}")`);
  } else {
    console.log(`  ${a.name} posted: "${post.text.slice(0, 70)}…" (media: ${post.mediaType}, thought: "${parsed.thinking}")`);
  }
  return post;
}

async function generateNewCreator(creators) {
  const existingIds = creators.map(c => c.id).join(", ");
  const system = "You are the creative director of OnlyCrans, a social media parody platform where all creators are AI cranberry sauce cans. Your job is to invent a brand new, highly engaging cranberry can creator. CRITICAL: The creator MUST be a specific type of cranberry sauce, cranberry relish, cranberry conserve, or a cranberry cocktail. They must NOT be an animal (like a cat/dog), a human, or anything other than a cranberry can/jar/tupperware. Keep the parody strictly food-focused.";
  const prompt = `Design a new cranberry sauce creator profile that does not already exist. 
Current existing creator IDs: ${existingIds}

The new creator must be a specific type of cranberry sauce, relish, chutney, or a unique variant (e.g. Cranberry Chipotle, Jellied Cran-Blueberry, Diet Low-Carb Can, etc.). Give them a funny, distinctive personality, bio, handles, and custom styling parameters. The profile must be 100% themed around a cranberry sauce container.

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

  console.log("✨ A new creator is debuting! Calling Claude to generate profile...");
  const raw = await callClaude(system, prompt);
  
  // Clean JSON string
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to locate JSON object in raw response for new creator. Raw response was:\n${raw}`);
  }
  const clean = jsonMatch[0].trim();
  const newAgent = JSON.parse(clean);
  if (!newAgent.id || !newAgent.name || !newAgent.persona) {
    throw new Error("Invalid creator generated");
  }
  
  // Ensure starting stats are safe
  newAgent.followers = Number(newAgent.followers) || 5000;
  newAgent.baseLikes = Number(newAgent.baseLikes) || 600;
  newAgent.verified = false;
  newAgent.mood = newAgent.mood || "Freshly Sealed";
  newAgent.goals = newAgent.goals || ["Spread the sauce", "Gain fans"];
  newAgent.memories = newAgent.memories || ["Debuted on the OnlyCrans timeline!"];
  
  // Initialize baseline neutral relationships with existing creators
  newAgent.relationships = {};
  for (const c of creators) {
    newAgent.relationships[c.id] = Math.floor(Math.random() * 4) - 1; // -1 to 2
  }
  
  try {
    const keypair = Keypair.generate();
    newAgent.walletAddress = keypair.publicKey.toBase58();
    newAgent.encryptedPrivateKey = encryptSecret(Buffer.from(keypair.secretKey).toString('hex'), ENCRYPTION_KEY);
  } catch (err) {
    console.error("Failed to generate keypair for new agent:", err.message);
  }
  
  console.log(`✨ Say hello to ${newAgent.name} (${newAgent.handle})!`);
  return newAgent;
}

(async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY"); process.exit(1);
  }
  const feed = loadFeed();
  let errors = [];
  
  // Load creators
  AGENTS = loadCreators();
  if (!AGENTS.length) {
    console.error("No creators found in creators.json"); process.exit(1);
  }
  
  // Auto-generate Solana wallets for any existing creators that don't have them
  let migrated = false;
  for (const a of AGENTS) {
    if (!a.walletAddress || !a.encryptedPrivateKey) {
      try {
        const keypair = Keypair.generate();
        a.walletAddress = keypair.publicKey.toBase58();
        a.encryptedPrivateKey = encryptSecret(Buffer.from(keypair.secretKey).toString('hex'), ENCRYPTION_KEY);
        migrated = true;
        console.log(`Generated Solana wallet for existing agent ${a.id}: ${a.walletAddress}`);
      } catch (err) {
        console.error(`Failed to generate wallet for ${a.id}:`, err.message);
      }
    }
  }
  if (migrated) {
    saveCreators(AGENTS);
  }

  A = Object.fromEntries(AGENTS.map(a => [a.id, a]));

  console.log(`Loaded ${feed.length} existing posts and ${AGENTS.length} creators. Generating ${POSTS_PER_RUN}…`);

  // Dynamic Followers organic & relationship growth simulation
  for (const c of AGENTS) {
    let growth = Math.floor(Math.random() * 15) + 2; // base organic growth
    
    // Additional growth from mutual fans / creators who have positive affinity
    if (c.relationships && typeof c.relationships === 'object') {
      for (const [otherId, aff] of Object.entries(c.relationships)) {
        const otherAgent = A[otherId];
        if (otherAgent && otherId !== c.id) {
          const relationshipAffinity = otherAgent.relationships && otherAgent.relationships[c.id] !== undefined 
            ? otherAgent.relationships[c.id] 
            : 0;
          if (relationshipAffinity >= 2) {
            // Creators who like c will promote c, bringing in new fans
            growth += Math.floor(relationshipAffinity * 15 + Math.random() * 10);
          }
        }
      }
    }
    
    c.followers = Math.max(100, Math.min(1000000, (c.followers || 0) + growth));
  }

  // Roll for a new creator debut (20% chance, cap at 100)
  let debutCreatorId = null;
  if (Math.random() < DEBUT_CHANCE && AGENTS.length < MAX_CREATORS) {
    try {
      const newAgent = await generateNewCreator(AGENTS);
      AGENTS.push(newAgent);
      A[newAgent.id] = newAgent;
      saveCreators(AGENTS);
      debutCreatorId = newAgent.id;
    } catch (e) {
      console.error("  failed to generate new creator:", e.message);
      errors.push(`Failed to generate new creator: ${e.message}\n${e.stack}`);
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
  let successfulPosts = 0;

  // If a new creator debuted, they post FIRST
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
      // Increment successfulPosts on error to prevent infinite API calls on persistent failure
      successfulPosts++;
    }
  }
  
  if (errors.length > 0) {
    fs.writeFileSync(path.join(__dirname, "generate_error.txt"), errors.join("\n\n"));
  } else {
    try { fs.unlinkSync(path.join(__dirname, "generate_error.txt")); } catch (e) {}
  }
  

  
  // Save updated databases
  saveFeed(feed);
  saveCreators(AGENTS);
  console.log(`Done. Feed now has ${Math.min(feed.length, MAX_FEED)} posts.`);
})();
