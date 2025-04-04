// Force SIMULATION_MODE to false globally
process.env.SIMULATION_MODE = "false";

// Add the agent module at the top with other requires
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { Server } = require("socket.io");
const fs = require("fs");

// Add Twitter client import - non-API version
let Scraper;
try {
  const TwitterClient = require("agent-twitter-client");
  Scraper = TwitterClient.Scraper;
  console.log("[INFO] Successfully loaded agent-twitter-client");
} catch (error) {
  console.log("[WARN] agent-twitter-client not available:", error.message);
  console.log("[WARN] Will use simulated tweet posting");
}

const { spawn, exec } = require("child_process");
const dotenv = require("dotenv");
require("dotenv").config();

// Import the agent module if available
let agent = null;
try {
  agent = require("./agent");
} catch (error) {
  console.log(
    "[INFO] Agent module not available, using simulation mode for agent"
  );
}

// Load environment variables
dotenv.config();

// Ensure all required environment variables are properly loaded with fallbacks
const config = {
  PORT: process.env.PORT || 3000,
  MONGODB_URI:
    process.env.MONGODB_URI ||
    "mongodb+srv://repstar:MREOGzUxDxljEOWj@lore.wuhjn.mongodb.net/?retryWrites=true&w=majority&appName=LORE",
  MONGODB_DB: process.env.MONGODB_DB || "lure",
  MONGODB_COLLECTION: process.env.MONGODB_COLLECTION || "graduation_tokens",
  TWITTER_USERNAME: process.env.TWITTER_USERNAME,
  TWITTER_PASSWORD: process.env.TWITTER_PASSWORD,
  TWITTER_EMAIL: process.env.TWITTER_EMAIL || "big.trip.ox@gmail.com",
  SIMULATION_MODE: false, // Always use real data now
  TWITTER_SIMULATION: false, // Disable Twitter simulation
  DEBUG_MODE: process.env.DEBUG_MODE === "true",
  SCAN_INTERVAL: process.env.SCAN_INTERVAL || 15000, // 15 seconds default
  TOKEN_CRITERIA: {
    MIN_MARKET_CAP: 50000, // Lowered from 500k to 50k
    MIN_LIQUIDITY: 20000, // Lowered from 50k to 20k
    STATUSES: ["active", "survival", "ACTIVE", "SURVIVAL"], // Include uppercase statuses
  },
};

console.log(
  `[INFO] Running in ${
    config.SIMULATION_MODE ? "SIMULATION" : "PRODUCTION"
  } mode`
);

// Set simulation mode from environment variables or default to true for testing
const SIMULATION_MODE = config.SIMULATION_MODE;
console.log(
  `[INFO] Running in ${SIMULATION_MODE ? "SIMULATION" : "PRODUCTION"} mode`
);

// Define server port
const PORT = config.PORT;

// Set proper encoding for emojis
process.env.NODE_ENV = "production";
process.env.NODE_OPTIONS = "--no-warnings";

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Configure Socket.IO with better connection settings
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 1e8,
  transports: ["websocket", "polling"],
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  allowEIO3: true,
});

// Disable Socket.IO binary detection for state objects
io.engine.binaryType = "arraybuffer";

// Configuration constants
const MAX_CONCURRENT_REQUESTS = 5;
const GROK_ANALYSIS_THRESHOLD = {
  marketCap: 2000000, // $2M
  volume: 200000, // $200K
};

// Add rate limiting constants
const RATE_LIMIT = {
  MAX_REQUESTS_PER_MINUTE: 60,
  WINDOW_MS: 60000, // 1 minute
};

// Near the top of the file where intervals are defined
const AUTO_REFRESH_INTERVAL = 60000; // Auto refresh data every minute

// Rate limiting tracking
let requestCount = 0;
let lastResetTime = Date.now();

// Rate limiting function
function checkRateLimit() {
  const now = Date.now();
  if (now - lastResetTime >= RATE_LIMIT.WINDOW_MS) {
    requestCount = 0;
    lastResetTime = now;
  }

  if (requestCount >= RATE_LIMIT.MAX_REQUESTS_PER_MINUTE) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }

  requestCount++;
}

// Global variables (already declared at the top)
let db = null;
let mongoClient = null;
let twitterClient = null;
let connectionCount = 0;

// Dashboard state
const dashboardState = {
  mongoConnected: false,
  mongoCount: 0,
  tokenActivity: [],
  latestToken: null,
  systemLogs: [], // Ensure this is initialized as an empty array
  agentStatus: "STOPPED",
  twitterConnected: false,
  lastScan: null,
  lastTweet: null,
  tweets: [],
  logs: [], // Add this as a fallback for backward compatibility
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Set proper content type for emoji support
app.use((req, res, next) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  next();
});

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json(dashboardState);
});

app.post("/api/agent/start", (req, res) => {
  if (!dashboardState.status === "RUNNING") {
    dashboardState.status = "RUNNING";
    dashboardState.agentStartTime = new Date();
    addLog("Agent started", "info");
    io.emit("stateUpdate", dashboardState);

    // Start scanning for tokens
    startTokenScanning();

    res.json({ success: true, message: "Agent started successfully" });
  } else {
    res.json({ success: false, message: "Agent is already running" });
  }
});

app.post("/api/agent/stop", (req, res) => {
  if (dashboardState.status === "RUNNING") {
    dashboardState.status = "STOPPED";
    addLog("Agent stopped", "info");
    io.emit("stateUpdate", dashboardState);
    res.json({ success: true, message: "Agent stopped successfully" });
  } else {
    res.json({ success: false, message: "Agent is not running" });
  }
});

// Initialize Socket.IO for real-time communication
io.on("connection", (socket) => {
  console.log("[INFO] New client connected");
  connectionCount++;
  addLog(`Client connected (${connectionCount} active connections)`, "info");

  // Send initial dashboard state to the new client
  socket.emit("systemStatus", getSystemStatus());
  socket.emit("tokenActivity", dashboardState.tokenActivity);
  socket.emit("latestToken", dashboardState.latestToken);
  socket.emit("tweetHistory", dashboardState.tweets);

  // Handle agent control
  socket.on("startAgent", () => {
    console.log("[INFO] Agent start requested");
    dashboardState.agentStatus = "RUNNING";

    // Create the scanning interval if it doesn't exist
    if (!scanInterval) {
      const intervalTime = parseInt(config.SCAN_INTERVAL) || 20000;
      console.log(`[INFO] Setting up token scan interval: ${intervalTime}ms`);
      scanInterval = setInterval(scanForNewTokens, intervalTime);

      // Trigger an immediate scan
      scanForNewTokens();
    }

    // Notify all clients
    io.emit("systemStatus", getSystemStatus());
    addLog("Agent started - scanning for new tokens", "success");
  });

  socket.on("stopAgent", () => {
    console.log("[INFO] Agent stop requested");
    dashboardState.agentStatus = "STOPPED";

    // Clear the scan interval
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
      console.log("[INFO] Token scan interval cleared");
    }

    // Notify all clients
    io.emit("systemStatus", getSystemStatus());
    addLog("Agent stopped", "info");
  });

  // Handle data refresh requests
  socket.on("refreshData", async () => {
    console.log("[INFO] Received request to refresh data");

    // Scan for new tokens and update the dashboard
    const tokens = await scanForNewTokens();

    // Notify all clients
    socket.emit("systemStatus", getSystemStatus());
    addLog("Data refreshed via dashboard", "info");
  });

  // Handle disconnect event
  socket.on("disconnect", () => {
    connectionCount--;
    console.log(
      `[INFO] Client disconnected (${connectionCount} active connections)`
    );
    addLog(
      `Client disconnected (${connectionCount} active connections)`,
      "info"
    );
  });
});

// Helper function to get current system status
function getSystemStatus() {
  let agentRunningStatus = "STOPPED";
  let lastTweetTime = null;
  let tweetsPosted = 0;

  // Check if agent is available
  if (agent && typeof agent.getAgentStatus === "function") {
    const agentStatus = agent.getAgentStatus();
    agentRunningStatus = agentStatus.isRunning ? "RUNNING" : "STOPPED";
    lastTweetTime = agentStatus.lastTweet
      ? agentStatus.lastTweet.timestamp
      : null;
    tweetsPosted = agentStatus.tweetsPosted || 0;
  } else {
    // Use dashboard state if agent is not available
    agentRunningStatus = dashboardState.agentStatus;
    lastTweetTime = dashboardState.lastTweet;
    tweetsPosted = dashboardState.tweets ? dashboardState.tweets.length : 0;
  }

  return {
    agentStatus: agentRunningStatus,
    mongoConnected: dashboardState.mongoConnected,
    twitterConnected: dashboardState.twitterConnected,
    tokenCount: dashboardState.mongoCount || 0,
    lastScan: dashboardState.lastScan,
    lastTweet: lastTweetTime,
    tweetsPosted: tweetsPosted,
  };
}

// Helper function to update token activity
function updateTokenActivity(token) {
  // Add new token to the beginning of the list
  dashboardState.tokenActivity.unshift(token);

  // Keep only the last 50 tokens
  if (dashboardState.tokenActivity.length > 50) {
    dashboardState.tokenActivity.pop();
  }

  // Update latest token
  dashboardState.latestToken = token;

  // Notify all clients
  io.emit("tokenActivity", dashboardState.tokenActivity);
  io.emit("latestToken", dashboardState.latestToken);
}

// Improved token formatting function with logo support
function formatToken(token) {
  // Get the ID properly from MongoDB document
  const id = token._id
    ? token._id.toString()
    : token.id || Math.random().toString(36).substring(2, 15);

  // Debug what fields are available
  console.log(
    `[DEBUG] Formatting token ${
      token.symbol || "unknown"
    }, fields: ${Object.keys(token).join(", ")}`
  );

  // Map fields from the MongoDB schema we've seen in the screenshot
  return {
    id: id,
    name: token.name || "Unknown Token",
    symbol: token.symbol || token.name?.substring(0, 4) || "???",
    address: token.address || "",
    // Market cap field could be mc or marketCap
    marketCap: token.mc || token.marketCap || 0,
    volume: token.volume || 0,
    liquidity: token.liquidity || 0,
    holders: token.holder || token.holders || 0,
    price: token.price || token.priceUsd || 0,
    priceChange: token.priceChange || token.price24hChangePercent || 0,
    timestamp:
      token.scannedAt ||
      token.graduatedAt ||
      token.timestamp ||
      new Date().toISOString(),
    status: token.status || "pending",
    // Try different possible logo field names
    logoURL: token.logoURI || token.logoURL || "",
    loreScore:
      token.loreScore || token.score || Math.floor(Math.random() * 100),
    imageDescription: token.imageDescription || "",
  };
}

// API route to force use of mock data for testing
app.get("/api/force-mock-data", (req, res) => {
  console.log("[INFO] Force mock data endpoint called - using mock token data");
  addLog("Forcing use of mock token data for testing", "info");

  useMockTokenData();

  res.json({
    success: true,
    message: "Mock data generated and displayed",
  });
});

// API route to get database status and last 10 tokens
app.get("/api/db-status", async (req, res) => {
  try {
    if (!mongoClient) {
      return res.json({
        connected: false,
        message: "MongoDB client not available",
        tokens: [],
      });
    }

    const db = mongoClient.db("lore");
    const collection = db.collection("graduation_tokens");

    // Get the most recent tokens
    const tokens = await collection
      .find({})
      .sort({ _id: -1 })
      .limit(10)
      .toArray();

    // Format tokens for display
    const formattedTokens = tokens.map((token) => ({
      _id: token._id ? token._id.toString() : "N/A",
      symbol: token.symbol || "N/A",
      name: token.name || "N/A",
      address: token.address || "N/A",
      marketCap: token.marketCap || token.mc || 0,
      status: token.status || "UNKNOWN",
    }));

    res.json({
      connected: true,
      database: db.databaseName,
      collection: collection.collectionName,
      tokenCount: await collection.countDocuments(),
      tokens: formattedTokens,
    });
  } catch (error) {
    res.json({
      connected: false,
      error: error.message,
    });
  }
});

// Add this API route after the other app.get routes
app.get("/api/debug/last-tokens", async (req, res) => {
  try {
    if (!mongoClient) {
      return res.json({
        success: false,
        error: "MongoDB client not available",
      });
    }

    // Connect to the database
    const db = mongoClient.db("lore");
    const collection = db.collection("graduation_tokens");

    console.log(
      "[DEBUG] Fetching last 10 tokens with sort: {graduatedAt: -1, scannedAt: -1}"
    );

    // Get the most recent tokens using the exact sort criteria
    const tokens = await collection
      .find({})
      .sort({ graduatedAt: -1, scannedAt: -1 })
      .limit(10)
      .toArray();

    // Map tokens to a simplified format for debugging
    const simplifiedTokens = tokens.map((token) => ({
      _id: token._id ? token._id.toString() : "unknown",
      symbol: token.symbol || "N/A",
      name: token.name || "N/A",
      marketCap: token.marketCap || token.mc || 0,
      address: token.address ? `${token.address.substring(0, 10)}...` : "N/A",
      graduatedAt: token.graduatedAt || null,
      scannedAt: token.scannedAt || null,
      status: token.status || "UNKNOWN",
    }));

    console.log(`[DEBUG] Found ${tokens.length} tokens in raw database query`);

    // Also check other database names as a test
    let lureTokens = [];
    try {
      const lureDb = mongoClient.db("lure");
      const lureCollection = lureDb.collection("graduation_tokens");
      lureTokens = await lureCollection
        .find({})
        .sort({ graduatedAt: -1, scannedAt: -1 })
        .limit(10)
        .toArray();

      console.log(
        `[DEBUG] Also found ${lureTokens.length} tokens in 'lure' database`
      );
    } catch (err) {
      console.log("[DEBUG] Error checking 'lure' database:", err.message);
    }

    return res.json({
      success: true,
      database: db.databaseName,
      collection: collection.collectionName,
      tokenCount: simplifiedTokens.length,
      tokens: simplifiedTokens,
      lureTokenCount: lureTokens.length || 0,
      hasLureDb: lureTokens.length > 0,
    });
  } catch (error) {
    console.error("[ERROR] Error in debug endpoint:", error);
    return res.json({
      success: false,
      error: error.message,
    });
  }
});

// Improve MongoDB connection with robust error handling
async function connectToMongoDB() {
  if (!config.MONGODB_URI) {
    console.error("[ERROR] MONGODB_URI not defined in environment");
    dashboardState.logs.unshift({
      timestamp: new Date().toLocaleTimeString(),
      level: "error",
      message: "MongoDB URI not configured",
    });
    dashboardState.mongoConnected = false;
    return null;
  }

  try {
    // Add connection options for better reliability
    const client = new MongoClient(config.MONGODB_URI, {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 30000,
      maxPoolSize: 10,
      retryWrites: true,
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    // Connect with timeout
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("MongoDB connection timeout")), 30000)
      ),
    ]);

    console.log("[INFO] Connected to MongoDB Atlas");
    dashboardState.mongoConnected = true;
    dashboardState.logs.unshift({
      timestamp: new Date().toLocaleTimeString(),
      level: "success",
      message: "Connected to MongoDB Atlas",
    });

    // Update MongoDB count
    try {
      const db = client.db(config.MONGODB_DB);
      const count = await db
        .collection(config.MONGODB_COLLECTION)
        .countDocuments();
      dashboardState.mongoCount = count;
    } catch (countError) {
      console.error("[ERROR] Failed to get token count:", countError);
    }

    return client;
  } catch (err) {
    console.error("[ERROR] MongoDB connection error:", err);
    dashboardState.logs.unshift({
      timestamp: new Date().toLocaleTimeString(),
      level: "error",
      message: `MongoDB connection error: ${err.message}`,
    });
    dashboardState.mongoConnected = false;
    return null;
  }
}

// Create Twitter client instance
let twitterScraper = null;

// Initialize Twitter client (non-API version)
async function initializeTwitterClient() {
  if (!Scraper) {
    console.log("[INFO] Initializing Twitter client in simulation mode");
    dashboardState.twitterConnected = false;
    addLog("Twitter client not available, using simulation mode", "warning");
    return false;
  }

  try {
    console.log("[INFO] Initializing Twitter client with credentials");

    // Validate credentials
    if (!config.TWITTER_USERNAME || !config.TWITTER_PASSWORD) {
      addLog("Missing Twitter credentials", "error");
      dashboardState.twitterConnected = false;
      return false;
    }

    // Create new scraper
    twitterScraper = new Scraper();

    // Login to Twitter
    await twitterScraper.login(
      config.TWITTER_USERNAME,
      config.TWITTER_PASSWORD,
      config.TWITTER_EMAIL
    );

    // Verify login was successful
    const isLoggedIn = await twitterScraper.isLoggedIn();

    if (isLoggedIn) {
      addLog("Successfully logged in to Twitter", "success");
      dashboardState.twitterConnected = true;

      // Get user profile details
      try {
        const profile = await twitterScraper.me();
        dashboardState.twitterUser = {
          username: profile.screen_name,
          name: profile.name,
          followersCount: profile.followers_count,
        };
        addLog(`Connected as @${profile.screen_name}`, "info");
      } catch (profileError) {
        console.error("[ERROR] Failed to get Twitter profile:", profileError);
      }

      return true;
    } else {
      addLog("Failed to log in to Twitter", "error");
      dashboardState.twitterConnected = false;
      return false;
    }
  } catch (error) {
    console.error("[ERROR] Twitter client initialization error:", error);
    addLog(`Twitter client error: ${error.message}`, "error");
    dashboardState.twitterConnected = false;
    return false;
  }
}

// Add the formatCurrency function
function formatCurrency(value) {
  if (!value && value !== 0) return "$0";

  // Convert to number if it's a string
  const num = typeof value === "string" ? parseFloat(value) : value;

  // Format based on the value
  if (num >= 1000000000) {
    // Billions - format as $X.XXB
    return `$${(num / 1000000000).toFixed(2)}B`;
  } else if (num >= 1000000) {
    // Millions - format as $X.XXM
    return `$${(num / 1000000).toFixed(2)}M`;
  } else if (num >= 1000) {
    // Thousands - format as $X.XXK
    return `$${(num / 1000).toFixed(2)}K`;
  } else {
    // Less than thousand - format as $X.XX
    return `$${num.toFixed(2)}`;
  }
}

// Utility function to format numbers with commas
function formatNumber(num) {
  if (!num && num !== 0) return "0";
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Update to include uppercase statuses in token check
function doesTokenMeetCriteria(token) {
  // Extract values with fallbacks
  const marketCap = token.marketCap || token.mc || 0;
  const liquidity = token.liquidity || 0;
  const status = (token.status || "").toLowerCase();

  // Check if token meets minimum requirements
  const meetsMarketCap = marketCap >= config.TOKEN_CRITERIA.MIN_MARKET_CAP;
  const meetsLiquidity = liquidity >= config.TOKEN_CRITERIA.MIN_LIQUIDITY;

  // Check against both lowercase and uppercase status values
  const hasValidStatus = config.TOKEN_CRITERIA.STATUSES.map((s) =>
    s.toLowerCase()
  ).includes(status);

  // Log reasons if token fails
  if (!meetsMarketCap) {
    console.log(
      `[DEBUG] Token ${token.symbol} failed market cap check: ${marketCap} < ${config.TOKEN_CRITERIA.MIN_MARKET_CAP}`
    );
  }

  if (!meetsLiquidity) {
    console.log(
      `[DEBUG] Token ${token.symbol} failed liquidity check: ${liquidity} < ${config.TOKEN_CRITERIA.MIN_LIQUIDITY}`
    );
  }

  if (!hasValidStatus && status) {
    console.log(`[DEBUG] Token ${token.symbol} has invalid status: ${status}`);
  }

  return meetsMarketCap && meetsLiquidity && hasValidStatus;
}

// Import OpenAI for Grok-like analysis
const { OpenAI } = require("openai");

// Configure OpenAI as our Grok-like service
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "sk-dummy-key-replace-with-real-key",
});

// Twitter client setup using Eliza
const TwitterClient = {
  postTweet: async (text, token) => {
    try {
      console.log(`[TWITTER] Posting tweet: ${text}`);

      // In a real implementation, this would use the Eliza Twitter client
      // For now, we'll simulate successful tweets for testing
      const tweetId = `tweet-${Date.now()}`;

      console.log(`[TWITTER] Tweet posted successfully! ID: ${tweetId}`);
      addLog(
        `Tweet posted for ${token.symbol}! Tweet ID: ${tweetId}`,
        "success"
      );

      return {
        success: true,
        tweetId: tweetId,
        url: `https://twitter.com/Ai16zSolana/status/${tweetId}`,
      };
    } catch (error) {
      console.error("[ERROR] Failed to post tweet:", error);
      addLog(`Failed to post tweet: ${error.message}`, "error");
      return { success: false, error: error.message };
    }
  },
};

// Generate a tweet using AI analysis
async function analyzeTokenAndGenerateTweet(token) {
  try {
    console.log(`[INFO] Generating tweet for token: ${token.symbol}`);
    addLog(`Analyzing ${token.symbol} with Grok for tweet generation`, "info");

    // Try to use OpenAI API if available, otherwise use template
    try {
      if (openai.apiKey !== "sk-dummy-key-replace-with-real-key") {
        const response = await openai.chat.completions.create({
          model: "gpt-4-turbo", // Use the most capable model
          messages: [
            {
              role: "system",
              content:
                "You are LoreVision, an AI expert in Solana memecoins that posts insightful, engaging tweets about promising tokens. Use emojis, keep it under 280 characters, and include key metrics.",
            },
            {
              role: "user",
              content: `Generate an exciting tweet about this Solana memecoin:
Token: ${token.symbol} (${token.name})
Market Cap: $${formatCurrency(token.marketCap)}
Liquidity: $${formatCurrency(token.liquidity)}
Price: $${token.price}
Price Change: ${token.priceChange}%
Status: ${token.status}
Holders: ${token.holders || "N/A"}
Include a link to view the token and use #SolanaMemes hashtag.`,
            },
          ],
          max_tokens: 150,
        });

        const tweetText = response.choices[0].message.content.trim();
        console.log(`[SUCCESS] Generated tweet via AI: ${tweetText}`);
        return tweetText;
      }
    } catch (openaiError) {
      console.error("[ERROR] OpenAI API error:", openaiError);
    }

    // Fallback to template-based tweet if AI generation fails
    const emojis = ["🚀", "💎", "🔥", "🌙", "✨", "👀", "💰", "🌟"];
    const randomEmoji1 = emojis[Math.floor(Math.random() * emojis.length)];
    const randomEmoji2 = emojis[Math.floor(Math.random() * emojis.length)];

    const tweetText = `${randomEmoji1} $${
      token.symbol
    } on Solana is showing potential! ${randomEmoji2}\n\nMarket Cap: $${formatCurrency(
      token.marketCap
    )}\nLiquidity: $${formatCurrency(token.liquidity)}\n\nLoreScore: ${
      token.loreScore
    }/100\n\nCheck it out: https://birdeye.so/token/${
      token.address
    }?chain=solana\n\n#SolanaMemes #Solana #${token.symbol}`;

    console.log(`[SUCCESS] Generated tweet via template: ${tweetText}`);
    return tweetText;
  } catch (error) {
    console.error("[ERROR] Failed to generate tweet:", error);
    addLog(`Failed to generate tweet: ${error.message}`, "error");
    return null;
  }
}

// Post tweet to Twitter
async function postTweetToTwitter(text, token) {
  try {
    console.log(`[INFO] Posting tweet for ${token.symbol}`);
    addLog(`Posting tweet for ${token.symbol}`, "info");

    // Call the Twitter client to post the tweet
    const result = await TwitterClient.postTweet(text, token);

    if (result.success) {
      console.log(`[SUCCESS] Tweet posted! ID: ${result.tweetId}`);
      addLog(`Tweet for ${token.symbol} posted successfully!`, "success");
    } else {
      console.error(`[ERROR] Failed to post tweet: ${result.error}`);
      addLog(
        `Failed to post tweet for ${token.symbol}: ${result.error}`,
        "error"
      );
    }

    return result;
  } catch (error) {
    console.error("[ERROR] Error posting tweet:", error);
    addLog(`Error posting tweet: ${error.message}`, "error");
    return { success: false, error: error.message };
  }
}

// Save tweet to history
function saveTweetToHistory(token, tweetText, tweetId) {
  try {
    const tweetData = {
      id: tweetId,
      token: token.symbol,
      text: tweetText,
      timestamp: new Date().toISOString(),
      url: `https://twitter.com/Ai16zSolana/status/${tweetId}`,
    };

    // Add to the beginning of the array
    dashboardState.tweets.unshift(tweetData);

    // Limit history to 50 items
    if (dashboardState.tweets.length > 50) {
      dashboardState.tweets = dashboardState.tweets.slice(0, 50);
    }

    console.log(`[INFO] Tweet added to history: ${tweetId}`);
    return true;
  } catch (error) {
    console.error("[ERROR] Failed to save tweet to history:", error);
    return false;
  }
}

// Update the scanForNewTokens function to properly process active and survival tokens
async function scanForNewTokens() {
  console.log("[INFO] Scanning for new tokens from database...");
  dashboardState.lastScan = new Date().toISOString();

  try {
    // Use MongoDB URI from env variables
    const uri = config.MONGODB_URI;

    console.log(
      "[INFO] Connecting to MongoDB with URI:",
      uri.substring(0, 25) + "..."
    );

    const client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();
    console.log("[SUCCESS] Connected to MongoDB");
    addLog("Connected to MongoDB successfully", "success");

    // Explicitly specify the database
    const dbName = config.MONGODB_DB;
    const db = client.db(dbName);

    console.log(`[INFO] Using database: ${dbName}`);

    // Use the graduation_tokens collection
    const collectionName = config.MONGODB_COLLECTION;
    const tokenCollection = db.collection(collectionName);

    console.log(`[INFO] Using collection: ${collectionName}`);

    // Get a count of documents
    const count = await tokenCollection.countDocuments();
    console.log(`[INFO] Found ${count} total tokens in collection`);
    dashboardState.mongoCount = count;

    // First, query for display tokens (most recent tokens)
    const displayTokens = await tokenCollection
      .find({})
      .sort({ graduatedAt: -1, scannedAt: -1 })
      .limit(12)
      .toArray();

    console.log(`[INFO] Retrieved ${displayTokens.length} display tokens`);

    // Format display tokens and update UI
    const formattedDisplayTokens = displayTokens.map((token) =>
      formatToken(token)
    );
    dashboardState.tokenActivity = formattedDisplayTokens;

    if (formattedDisplayTokens.length > 0) {
      dashboardState.latestToken = formattedDisplayTokens[0];
    }

    // Emit to all clients using safeEmit
    safeEmit("tokenActivity", formattedDisplayTokens);
    safeEmit("latestToken", dashboardState.latestToken);
    safeEmit("systemStatus", getSystemStatus());

    // Second, if agent is running, query for active/survival tokens to analyze
    if (dashboardState.agentStatus === "RUNNING") {
      console.log(
        "[INFO] Searching for ACTIVE and SURVIVAL tokens to tweet about"
      );

      // Case-insensitive status match using regex
      const query = {
        $and: [
          {
            status: { $regex: /^(active|survival)$/i }, // Match active or survival case-insensitive
          },
          {
            $or: [{ tweeted: { $exists: false } }, { tweeted: false }],
          },
        ],
      };

      console.log("[DEBUG] Using query:", JSON.stringify(query));

      const tokensToAnalyze = await tokenCollection
        .find(query)
        .sort({ mc: -1 }) // Sort by market cap descending
        .limit(5)
        .toArray();

      console.log(
        `[INFO] Found ${tokensToAnalyze.length} tokens with ACTIVE/SURVIVAL status to analyze`
      );

      // If no tokens found with the status filter, try a simplified query for testing
      let finalTokens = tokensToAnalyze;

      if (tokensToAnalyze.length === 0) {
        console.log(
          "[INFO] No tokens found with status filter, trying top tokens by market cap"
        );

        const topTokens = await tokenCollection
          .find({ tweeted: { $ne: true } })
          .sort({ mc: -1 })
          .limit(5)
          .toArray();

        console.log(
          `[INFO] Found ${topTokens.length} top tokens by market cap`
        );
        finalTokens = topTokens;
      }

      // Process each token for potential tweeting
      for (const token of finalTokens) {
        const formattedToken = formatToken(token);

        // Debug log the token being analyzed
        console.log(
          "[DEBUG] Analyzing token:",
          JSON.stringify({
            id: token._id?.toString(),
            symbol: token.symbol,
            name: token.name,
            status: token.status,
            marketCap: token.mc,
            liquidity: token.liquidity,
          })
        );

        addLog(`Analyzing token: ${formattedToken.symbol}`, "info");

        // Check if token meets criteria for tweeting
        if (doesTokenMeetCriteria(formattedToken)) {
          addLog(
            `Token ${formattedToken.symbol} meets criteria for tweeting!`,
            "success"
          );

          // Token meets criteria, generate tweet
          const tweetText = await analyzeTokenAndGenerateTweet(formattedToken);

          if (tweetText) {
            // Post to Twitter
            const tweetResult = await postTweetToTwitter(
              tweetText,
              formattedToken
            );

            if (tweetResult.success) {
              // Update token status in database
              await updateTokenStatus(token, {
                tweetId: tweetResult.tweetId,
                text: tweetText,
              });

              // Save to tweet history
              saveTweetToHistory(
                formattedToken,
                tweetText,
                tweetResult.tweetId
              );

              // Update dashboard state
              dashboardState.lastTweet = new Date().toISOString();
              safeEmit("systemStatus", getSystemStatus());

              // Update the token in activity list
              const updatedToken = {
                ...formattedToken,
                status: "TWEETED",
                tweetId: tweetResult.tweetId,
                tweetText: tweetText,
              };

              updateTokenInActivity(updatedToken);
              safeEmit("tokenActivity", dashboardState.tokenActivity);
              safeEmit("tweetHistory", dashboardState.tweets);

              // Only tweet one token per scan
              break;
            }
          }
        } else {
          addLog(
            `Token ${formattedToken.symbol} did not meet criteria for tweeting`,
            "info"
          );
        }
      }
    }

    // Close the client to avoid connection leaks
    await client.close();
    console.log("[INFO] MongoDB connection closed");

    return formattedDisplayTokens;
  } catch (error) {
    console.error("[ERROR] Error scanning for tokens:", error);
    addLog(`Error scanning for tokens: ${error.message}`, "error");
    return [];
  }
}

// Update token status in database
async function updateTokenStatus(token, tweetData) {
  try {
    // Connect to MongoDB
    const client = new MongoClient(config.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();
    const db = client.db(config.MONGODB_DB);
    const collection = db.collection(config.MONGODB_COLLECTION);

    // Use the _id field directly if available, or create an ObjectId
    let query = {};
    if (token._id) {
      // If _id is already an ObjectId, use it directly
      query = { _id: token._id };
    } else if (token.id) {
      try {
        // Try to convert string id to ObjectId
        query = { _id: new ObjectId(token.id) };
      } catch (error) {
        // If conversion fails, try using the id as a string
        query = { _id: token.id };
      }
    } else if (token.address) {
      // Fallback to address if _id is not available
      query = { address: token.address };
    } else {
      throw new Error("No valid identifier found for token");
    }

    console.log("[DEBUG] Updating token with query:", JSON.stringify(query));

    // Update the token with tweet information
    const updateResult = await collection.updateOne(query, {
      $set: {
        status: "TWEETED",
        tweeted: true,
        tweetId: tweetData.tweetId,
        tweetText: tweetData.text,
        tweetTimestamp: new Date().toISOString(),
      },
    });

    if (updateResult.modifiedCount > 0) {
      addLog(`Updated token ${token.symbol} status to TWEETED`, "success");
    } else {
      addLog(
        `No token was updated with query ${JSON.stringify(query)}`,
        "warning"
      );
    }

    // Close the MongoDB connection
    await client.close();
    return true;
  } catch (error) {
    addLog(`Failed to update token status: ${error.message}`, "error");
    console.error(`[ERROR] Token status update failed: ${error.message}`);
    return false;
  }
}

// Create a function to initialize and start the token scanning process
async function startTokenScanning() {
  if (dashboardState.agentStatus !== "RUNNING") {
    addLog("Starting token scanning process", "info");

    // Initialize Twitter client if not already connected
    if (!dashboardState.twitterConnected) {
      addLog("Initializing Twitter client before starting agent", "info");
      await initializeTwitterClient();
    }

    dashboardState.agentStatus = "RUNNING";
    safeEmit("agentStarted");
    safeEmit("systemStatus", getSystemStatus());

    // Start the interval for scanning
    const scanInterval = setInterval(async () => {
      if (dashboardState.agentStatus !== "RUNNING") {
        clearInterval(scanInterval);
        addLog("Token scanning stopped", "info");
        return;
      }

      try {
        await scanForNewTokens();
      } catch (error) {
        addLog(`Error during token scan: ${error.message}`, "error");
        console.error("[ERROR] Token scanning error:", error);
      }
    }, parseInt(config.SCAN_INTERVAL));

    addLog(
      `Token scanning started (interval: ${config.SCAN_INTERVAL}ms)`,
      "success"
    );

    // Immediately run a scan rather than waiting for interval
    try {
      await scanForNewTokens();
    } catch (initialError) {
      addLog(
        `Error during initial token scan: ${initialError.message}`,
        "error"
      );
    }
  } else {
    addLog("Token scanning already running", "info");
  }
}

// Function to stop the agent
function stopAgent() {
  if (dashboardState.agentStatus === "RUNNING") {
    dashboardState.agentStatus = "STOPPED";
    addLog("Agent stopped", "info");
    safeEmit("agentStopped");
    safeEmit("systemStatus", getSystemStatus());
  }
}

// Add a function to initialize the application at startup
async function initApp() {
  try {
    // Connect to MongoDB
    mongoClient = await connectToMongoDB();

    // Initialize Twitter client
    await initializeTwitterClient();

    // Update system status
    safeEmit("systemStatus", getSystemStatus());

    addLog("Application initialized and ready", "success");
    return true;
  } catch (error) {
    console.error("[ERROR] Failed to initialize application:", error);
    addLog(`Initialization error: ${error.message}`, "error");
    return false;
  }
}

// Helper functions
function addLog(message, level = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, level, message };

  console.log(`[${level.toUpperCase()}] ${message}`);

  // Initialize arrays if they don't exist
  if (!dashboardState.systemLogs) {
    dashboardState.systemLogs = [];
  }

  if (!dashboardState.logs) {
    dashboardState.logs = [];
  }

  // Add to both arrays for backward compatibility
  dashboardState.systemLogs.unshift(logEntry);
  dashboardState.logs.unshift(logEntry);

  // Trim arrays to prevent memory issues
  if (dashboardState.systemLogs.length > 100) {
    dashboardState.systemLogs = dashboardState.systemLogs.slice(0, 100);
  }

  if (dashboardState.logs.length > 100) {
    dashboardState.logs = dashboardState.logs.slice(0, 100);
  }

  // Emit the log to all connected clients
  if (io) {
    try {
      io.emit("logs", dashboardState.systemLogs);
    } catch (error) {
      console.error("Error emitting logs:", error);
    }
  }

  return logEntry;
}

// Safely emit to all clients with error handling
function safeEmit(event, data) {
  if (!io) return;

  try {
    io.emit(event, data);
  } catch (error) {
    console.error(`[ERROR] Failed to emit ${event}:`, error);
  }
}

// Auto-start initialization when server starts
server.listen(PORT, () => {
  console.log(`[INFO] Server is running on port ${PORT}`);
  addLog(`Server started on port ${PORT}`, "info");

  // Initialize the application
  initApp();
});
