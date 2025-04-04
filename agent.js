// agent.js - LoreVision Agent for scanning and tweeting about tokens
const { MongoClient } = require("mongodb");
const { Scraper } = require("agent-twitter-client");
require("dotenv").config();

// Agent state management
let agentState = {
  isRunning: false,
  scanInterval: null,
  lastScannedTokens: new Set(), // To track already processed tokens
  lastTweet: null,
  tweetsPosted: 0,
};

// Set up the Twitter client
async function setupTwitterClient() {
  try {
    const username = process.env.TWITTER_USERNAME;
    const password = process.env.TWITTER_PASSWORD;
    const email = process.env.TWITTER_EMAIL;
    const apiKey = process.env.TWITTER_API_KEY;
    const apiSecretKey = process.env.TWITTER_API_SECRET_KEY;
    const accessToken = process.env.TWITTER_ACCESS_TOKEN;
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

    if (!username || !password) {
      console.log("[WARNING] Twitter credentials not configured");
      return null;
    }

    console.log("[INFO] Setting up Twitter client...");
    const scraper = new Scraper();

    // Use full login if API keys are available
    if (apiKey && apiSecretKey && accessToken && accessTokenSecret) {
      await scraper.login(
        username,
        password,
        email,
        apiKey,
        apiSecretKey,
        accessToken,
        accessTokenSecret
      );
      console.log("[SUCCESS] Twitter client logged in with API keys");
    } else {
      // Fallback to basic login
      await scraper.login(username, password);
      console.log("[SUCCESS] Twitter client logged in (basic auth)");
    }

    const isLoggedIn = await scraper.isLoggedIn();
    if (isLoggedIn) {
      console.log("[SUCCESS] Twitter login verified");
      return scraper;
    } else {
      console.log("[ERROR] Twitter login failed verification");
      return null;
    }
  } catch (error) {
    console.error("[ERROR] Twitter client setup failed:", error);
    return null;
  }
}

// Generate tweet content using Grok
async function generateTweetWithGrok(token, twitterClient) {
  try {
    if (!twitterClient) {
      console.log(
        "[ERROR] Cannot generate tweet: Twitter client not available"
      );
      return null;
    }

    console.log(`[INFO] Generating tweet for ${token.symbol} with Grok...`);

    const prompt = `I'm analyzing a Solana meme token. Please create an engaging, informative tweet (max 280 chars) about it with these details:
    
Name: ${token.name} (${token.symbol})
Address: ${token.address}
Market Cap: $${formatNumber(token.marketCap)}
Liquidity: $${formatNumber(token.liquidity)}
${token.holders ? `Holders: ${token.holders}` : ""}
${token.price ? `Price: $${token.price}` : ""}
${token.priceChange ? `24h Change: ${token.priceChange}%` : ""}
Status: ${token.status}

Include: 
- Brief token analysis
- Key metrics
- At least two relevant emojis
- Hashtags: #Solana #SolanaMemes
- Make it sound excited but professional`;

    // Call Grok via Twitter client
    const response = await twitterClient.grokChat({
      messages: [{ role: "user", content: prompt }],
    });

    const tweetContent = response.message;

    if (tweetContent) {
      console.log(`[SUCCESS] Generated tweet for ${token.symbol}`);
      return tweetContent;
    } else {
      console.log(`[ERROR] Failed to generate tweet for ${token.symbol}`);
      return null;
    }
  } catch (error) {
    console.error(
      `[ERROR] Tweet generation failed for ${token.symbol}:`,
      error
    );
    return null;
  }
}

// Post tweet to Twitter
async function postTweet(tweetContent, token, twitterClient) {
  try {
    if (!twitterClient) {
      console.log("[ERROR] Cannot post tweet: Twitter client not available");
      return false;
    }

    console.log(`[INFO] Posting tweet for ${token.symbol}...`);

    // Post the tweet
    const result = await twitterClient.sendTweet(tweetContent);

    if (result) {
      console.log(
        `[SUCCESS] Tweet posted for ${token.symbol}: ${
          result.id_str || "Success"
        }`
      );
      agentState.lastTweet = {
        content: tweetContent,
        tokenSymbol: token.symbol,
        timestamp: new Date().toISOString(),
      };
      agentState.tweetsPosted++;

      // Update token status in MongoDB
      try {
        const uri =
          process.env.MONGODB_URI ||
          "mongodb+srv://repstar:MREOGzUxDxljEOWj@lore.wuhjn.mongodb.net/?retryWrites=true&w=majority&appName=LORE";
        const client = new MongoClient(uri, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
        });
        await client.connect();
        const db = client.db(process.env.MONGODB_DB || "lure");
        const collection = db.collection(
          process.env.MONGODB_COLLECTION || "graduation_tokens"
        );

        await collection.updateOne(
          { _id: token._id },
          { $set: { status: "TWEETED", tweetedAt: new Date().toISOString() } }
        );

        console.log(`[SUCCESS] Updated status for ${token.symbol} to TWEETED`);
        await client.close();
      } catch (dbError) {
        console.error(
          `[ERROR] Failed to update token status in DB: ${dbError.message}`
        );
      }

      return true;
    } else {
      console.log(`[ERROR] Failed to post tweet for ${token.symbol}`);
      return false;
    }
  } catch (error) {
    console.error(`[ERROR] Tweet posting failed for ${token.symbol}:`, error);
    return false;
  }
}

// Scan for tokens to tweet about
async function scanForTokensToTweet(twitterClient, addLog, updateDashboard) {
  if (!agentState.isRunning) return;

  console.log("[INFO] Scanning for tokens to tweet...");
  if (addLog) addLog("Scanning for tokens to tweet...", "info");

  try {
    // Connect to MongoDB
    const uri =
      process.env.MONGODB_URI ||
      "mongodb+srv://repstar:MREOGzUxDxljEOWj@lore.wuhjn.mongodb.net/?retryWrites=true&w=majority&appName=LORE";

    const client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await client.connect();

    const db = client.db(process.env.MONGODB_DB || "lure");
    const collection = db.collection(
      process.env.MONGODB_COLLECTION || "graduation_tokens"
    );

    // Count total tokens
    const count = await collection.countDocuments();

    // Query for active or survival tokens that haven't been tweeted yet
    const tokens = await collection
      .find({
        status: { $in: ["ACTIVE", "active", "SURVIVAL", "survival"] },
        $or: [{ tweetedAt: { $exists: false } }, { tweetedAt: null }],
      })
      .sort({ graduatedAt: -1, scannedAt: -1 })
      .limit(3) // Process up to 3 tokens per scan
      .toArray();

    console.log(`[INFO] Found ${tokens.length} tokens eligible for tweeting`);
    if (addLog)
      addLog(`Found ${tokens.length} tokens eligible for tweeting`, "info");

    // Process tokens
    for (const token of tokens) {
      const tokenId = token._id?.toString();

      // Skip if we've already processed this token
      if (agentState.lastScannedTokens.has(tokenId)) {
        continue;
      }

      // Add to processed set
      agentState.lastScannedTokens.add(tokenId);

      // Format token for easier use
      const formattedToken = {
        _id: token._id,
        id: tokenId,
        name: token.name || "",
        symbol: token.symbol || "",
        address: token.address || "",
        marketCap: token.mc || token.marketCap || 0,
        volume: token.volume || 0,
        liquidity: token.liquidity || 0,
        holders: token.holder || token.holders || 0,
        price: token.price || token.priceUsd || 0,
        priceChange: token.price24hChangePercent || 0,
        timestamp:
          token.graduatedAt ||
          token.timestamp ||
          token.firstSeenAt ||
          token.scannedAt ||
          new Date().toISOString(),
        status: token.status || "pending",
        logoURL: token.logoURI || "",
      };

      console.log(
        `[INFO] Processing token for tweeting: ${formattedToken.symbol}`
      );
      if (addLog)
        addLog(
          `Processing token for tweeting: ${formattedToken.symbol}`,
          "info"
        );

      // Generate tweet
      const tweetContent = await generateTweetWithGrok(
        formattedToken,
        twitterClient
      );

      if (tweetContent) {
        // Post tweet
        const success = await postTweet(
          tweetContent,
          formattedToken,
          twitterClient
        );
        if (success && addLog) {
          addLog(`Tweet posted for ${formattedToken.symbol}`, "success");
          if (updateDashboard) updateDashboard();
        }
      }
    }

    // Clean up MongoDB connection
    await client.close();
  } catch (error) {
    console.error("[ERROR] Token scanning for tweets failed:", error);
    if (addLog)
      addLog(`Token scanning for tweets failed: ${error.message}`, "error");
  }
}

// Start the agent
async function startAgent(addLog, updateDashboard) {
  if (agentState.isRunning) {
    console.log("[WARNING] Agent is already running");
    if (addLog) addLog("Agent is already running", "warning");
    return;
  }

  console.log("[INFO] Starting agent...");
  if (addLog) addLog("Starting agent...", "info");

  // Setup Twitter client
  const twitterClient = await setupTwitterClient();
  if (!twitterClient) {
    console.log("[ERROR] Failed to start agent: Twitter client setup failed");
    if (addLog)
      addLog("Failed to start agent: Twitter client setup failed", "error");
    return;
  }

  // Set agent as running
  agentState.isRunning = true;
  if (addLog) addLog("Agent started successfully", "success");
  if (updateDashboard) updateDashboard();

  // Initial scan
  await scanForTokensToTweet(twitterClient, addLog, updateDashboard);

  // Set interval for scanning (15 seconds)
  agentState.scanInterval = setInterval(() => {
    scanForTokensToTweet(twitterClient, addLog, updateDashboard);
  }, 15000);
}

// Stop the agent
function stopAgent(addLog, updateDashboard) {
  if (!agentState.isRunning) {
    console.log("[WARNING] Agent is not running");
    if (addLog) addLog("Agent is not running", "warning");
    return;
  }

  console.log("[INFO] Stopping agent...");
  if (addLog) addLog("Stopping agent...", "info");

  // Clear scan interval
  if (agentState.scanInterval) {
    clearInterval(agentState.scanInterval);
    agentState.scanInterval = null;
  }

  // Update state
  agentState.isRunning = false;
  if (addLog) addLog("Agent stopped", "success");
  if (updateDashboard) updateDashboard();
}

// Helper function to format numbers
function formatNumber(num, decimalPlaces = 2) {
  if (num === undefined || num === null) return "0";

  // Handle very small numbers for price display
  if (decimalPlaces > 2 && Math.abs(num) < 0.01) {
    return num.toFixed(decimalPlaces);
  }

  // Format with commas for thousands and fixed decimal places
  return Number(num).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimalPlaces,
  });
}

// Get agent status
function getAgentStatus() {
  return {
    isRunning: agentState.isRunning,
    lastTweet: agentState.lastTweet,
    tweetsPosted: agentState.tweetsPosted,
  };
}

// Export functions
module.exports = {
  startAgent,
  stopAgent,
  getAgentStatus,
};
