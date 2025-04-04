# LoreVision Dashboard - Step-by-Step Guide

This guide provides detailed instructions on how to run the LoreVision Dashboard, a sophisticated tool for Solana memecoin analysis, token tracking, and automated tweet generation.

## System Requirements

- Node.js v16 or higher
- npm (comes with Node.js)
- Internet connection (for MongoDB access)
- Windows operating system (recommended)

## Quick Start Guide

Follow these steps in order to set up and run the LoreVision Dashboard:

### 1. Navigate to the Project Directory

Open Command Prompt (cmd) or PowerShell and navigate to the dashboard directory:

```
cd C:\Users\Vince\OneDrive\Desktop\crosseye\lorevision-dashboard

(this may change depending where you saved the file the directory you after though is

\crosseye\lorevision-dashboard)
```

### 2. Install Dependencies

Run the following command to install all required dependencies:

```
npm install
```

This will install:

- express (web server)
- socket.io (real-time communication)
- mongodb (database connection)
- openai (optional, for AI-powered tweet generation)
- dotenv (environment configuration)

### 3. Configure Environment Variables

The .env file is already set up with the following:

- MongoDB connection string
- Database name and collection
- Port settings (default: 3001)
- Twitter API credentials

If you want to change the port, edit the PORT value in the .env file.

### 4. Run the Dashboard

To start the dashboard, run:

```
node index.js
```

You can also use the provided batch file for a better user experience:

```
start-dashboard.bat
```

The batch file will:

- Check if the port is already in use and offer solutions
- Install any missing dependencies
- Start the server with the correct configuration

### 5. Access the Dashboard

Once the server is running, open a web browser and go to:

```
http://localhost:3001
```

You should see the LoreVision Dashboard with:

- Token activity monitor
- System logs panel
- Latest token information
- Tweet history
- Agent control buttons

## Using the Dashboard

### Starting the Agent

1. Click the "START AGENT" button in the top-right corner
2. The agent will begin scanning for tokens with "active" or "survival" status
3. Tokens that meet the criteria will be analyzed and tweeted about
4. Tweet history will be displayed at the bottom of the dashboard

### Monitoring Tokens

The Token Activity Monitor displays:

- Token symbols and logos
- Addresses (shortened for readability)
- Market cap and liquidity values
- Timestamps and status indicators

### Reviewing System Logs

The System Logs panel shows:

- Connection status
- Agent activities
- Token analysis results
- Tweet generation and posting events

### Refreshing Data

Click the "REFRESH" button in the Token Activity Monitor to manually update the token data.

## Troubleshooting

### Port Already in Use

If you see an error like "address already in use :::3001":

1. Option 1: Kill the process using port 3001

   ```
   netstat -ano | findstr :3001
   taskkill /F /PID <PID_NUMBER>
   ```

2. Option 2: Change the port in .env file
   ```
   PORT=3002
   ```

### MongoDB Connection Issues

If you see MongoDB connection errors:

1. Check your internet connection
2. Verify the connection string in the .env file
3. Ensure the database and collection names are correct

### Twitter API Integration

The system is currently configured to simulate tweets. For real Twitter integration:

1. Ensure Twitter API credentials are valid in the .env file
2. Make sure the Eliza Twitter client is properly set up

## Additional Information

- The dashboard automatically refreshes data every 20 seconds
- Tokens are sorted by graduation time, with newest tokens at the top
- The system will only tweet about each token once
- Watch the logs panel for detailed information about the system's activities

---

For further assistance, consult the development team or refer to the technical documentation in the project repository.
