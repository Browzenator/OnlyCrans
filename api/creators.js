const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let kvUrl = process.env.KV_REST_API_URL;
  let kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl) kvUrl = kvUrl.replace(/^['"]|['"]$/g, '');
  if (kvToken) kvToken = kvToken.replace(/^['"]|['"]$/g, '');

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: "Vercel KV credentials not set in environment variables." });
  }

  try {
    const kvRes = await fetch(`${kvUrl}/get/creators`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!kvRes.ok) {
      throw new Error(`KV API returned status ${kvRes.status}`);
    }
    const data = await kvRes.json();

    if (data.result) {
      return res.status(200).json(JSON.parse(data.result));
    }

    // Bootstrap KV storage using local creators.json if database is currently empty
    const localPath = path.join(process.cwd(), 'creators.json');
    if (!fs.existsSync(localPath)) {
      return res.status(200).json([]);
    }
    const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));

    await fetch(`${kvUrl}/set/creators`, {
      headers: { Authorization: `Bearer ${kvToken}` },
      method: 'POST',
      body: JSON.stringify(localData)
    });

    console.log("Creators database successfully bootstrapped from local creators.json");
    return res.status(200).json(localData);
  } catch (error) {
    console.error("Creators API error:", error);
    return res.status(500).json({ error: error.message });
  }
};
