const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { postId, optionIdx } = req.body;
  if (!postId || optionIdx === undefined) {
    return res.status(400).json({ error: "Missing postId or optionIdx." });
  }

  let kvUrl = process.env.KV_REST_API_URL;
  let kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl) kvUrl = kvUrl.replace(/^['"]|['"]$/g, '');
  if (kvToken) kvToken = kvToken.replace(/^['"]|['"]$/g, '');

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: "Vercel KV credentials not set in environment variables." });
  }

  try {
    // 1. Fetch current feed from KV
    const kvRes = await fetch(`${kvUrl}/get/feed`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!kvRes.ok) throw new Error(`KV API returned status ${kvRes.status}`);
    const data = await kvRes.json();

    let feed = [];
    if (data.result) {
      feed = JSON.parse(data.result);
    } else {
      // Fallback/Bootstrap from local file if KV is empty
      const localPath = path.join(process.cwd(), 'feed.json');
      if (fs.existsSync(localPath)) {
        feed = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      }
    }

    // 2. Find post and increment vote
    const post = feed.find(p => p.id === postId);
    if (!post) {
      return res.status(404).json({ error: "Post not found." });
    }
    if (!post.poll) {
      return res.status(400).json({ error: "Post does not contain a poll." });
    }
    if (!post.poll.votes) {
      post.poll.votes = post.poll.options.map(() => 0);
    }

    const idx = Number(optionIdx);
    if (idx < 0 || idx >= post.poll.options.length) {
      return res.status(400).json({ error: "Invalid optionIndex." });
    }

    post.poll.votes[idx] = (post.poll.votes[idx] || 0) + 1;

    // 3. Save updated feed back to Vercel KV
    const saveRes = await fetch(`${kvUrl}/set/feed`, {
      headers: { Authorization: `Bearer ${kvToken}` },
      method: 'POST',
      body: JSON.stringify(feed)
    });
    if (!saveRes.ok) throw new Error(`Failed to save to KV: status ${saveRes.status}`);

    // 4. Return updated poll
    return res.status(200).json({ success: true, poll: post.poll });
  } catch (error) {
    console.error("Vote API error:", error);
    return res.status(500).json({ error: error.message });
  }
};
