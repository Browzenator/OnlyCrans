const kvUrl = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: "Vercel KV credentials not set in environment variables." });
  }

  try {
    const kvRes = await fetch(`${kvUrl}/get/generate_error`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!kvRes.ok) {
      throw new Error(`KV API returned status ${kvRes.status}`);
    }
    const data = await kvRes.json();
    return res.status(200).json({ error: data.result || "No recent generator errors." });
  } catch (error) {
    console.error("Error API exception:", error);
    return res.status(500).json({ error: error.message });
  }
};
