module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  try {
    const solana = require('@solana/web3.js');
    return res.status(200).json({ 
      success: true, 
      message: "Successfully required @solana/web3.js", 
      version: solana ? "present" : "missing" 
    });
  } catch (err) {
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      stack: err.stack 
    });
  }
};
