const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Configuration
const CONFIG = {
    API_BASE_URL: process.env.API_BASE_URL || 'URL_BEGIN_DOMAIN',
    PROXY_URL: process.env.PROXY_URL || 'http://localhost:5000/proxy',
    DEBUG_MODE: process.env.DEBUG_MODE === 'true' || true
};

// Load users configuration
let USERS_CONFIG = [];
try {
    const configData = fs.readFileSync('users-config.json', 'utf8');
    USERS_CONFIG = JSON.parse(configData).users;
    console.log(`Loaded configuration for ${USERS_CONFIG.length} users`);
} catch (error) {
    console.error('Error loading users configuration:', error);
    process.exit(1);
}

// Load refresh tokens from environment variables
function getRefreshToken(userId) {
    return process.env[`REFRESH_TOKEN_${userId.toUpperCase()}`];
}

// Global state with persistence
let globalState = {
    users: {},
    system: {
        startTime: new Date().toISOString(),
        lastStateSave: new Date().toISOString()
    }
};

// Initialize user states
USERS_CONFIG.forEach(userConfig => {
    globalState.users[userConfig.userId] = {
        userId: userConfig.userId,
        currentJWT: null,
        jwtExpiry: null,
        lastRefresh: null,
        refreshToken: getRefreshToken(userConfig.userId),
        spinnerStats: {
            totalSpins: 0,
            spinsToday: 0,
            lastSpin: null,
            nextSpin: null,
            spinResults: []
        },
        achievementStats: {
            lastCheck: null,
            totalClaimed: 0,
            claimedToday: 0,
            lastClaimed: []
        },
        fundStats: {
            currentSilver: 0,
            history: [],
            lastUpdate: null
        },
        activityLog: [],
        isActive: false,
        dailyResetScheduled: false,
        config: userConfig
    };
});

// State persistence
const STATE_FILE = 'tool-state.json';

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(globalState, null, 2));
        globalState.system.lastStateSave = new Date().toISOString();
    } catch (error) {
        console.error('Error saving state:', error);
    }
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            
            // Merge saved state with current configuration
            Object.keys(savedState.users || {}).forEach(userId => {
                if (globalState.users[userId]) {
                    // Preserve current JWT and refresh token
                    const currentJWT = globalState.users[userId].currentJWT;
                    const refreshToken = globalState.users[userId].refreshToken;
                    
                    globalState.users[userId] = {
                        ...savedState.users[userId],
                        currentJWT: currentJWT || savedState.users[userId].currentJWT,
                        refreshToken: refreshToken || savedState.users[userId].refreshToken,
                        config: globalState.users[userId].config // Keep current config
                    };
                }
            });
            
            console.log('State loaded from file');
        }
    } catch (error) {
        console.error('Error loading state:', error);
    }
}

// Auto-save state every 45 minutes
setInterval(saveState, 45 * 60 * 1000);

// Utility functions
function logActivity(userId, message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type, userId };
    
    if (globalState.users[userId]) {
        globalState.users[userId].activityLog.unshift(logEntry);
        
        // Keep only last 500 entries per user
        if (globalState.users[userId].activityLog.length > 500) {
            globalState.users[userId].activityLog = globalState.users[userId].activityLog.slice(0, 500);
        }
    }
    
    console.log(`[${timestamp}] [${userId}] ${type.toUpperCase()}: ${message}`);
}

function getCurrentUTCTime() {
    return new Date().toISOString().split('T')[1].substring(0, 8);
}

function isWithinActiveWindow(userId) {
    const user = globalState.users[userId];
    if (!user) return false;
    
    const now = new Date();
    const currentTime = now.toISOString().split('T')[1].substring(0, 5); // HH:MM
    
    // Check if we need daily reset
    checkAndResetDaily(userId);
    
    return currentTime >= user.config.dayStart && currentTime <= user.config.dayEnd;
}

function checkAndResetDaily(userId) {
    const user = globalState.users[userId];
    if (!user) return;
    
    const now = new Date();
    const currentTime = now.toISOString().split('T')[1].substring(0, 5);
    
    // Reset daily counters if past end time and not yet reset
    if (currentTime > user.config.dayEnd && !user.dailyResetScheduled) {
        logActivity(userId, 'Scheduling daily reset for tomorrow');
        user.dailyResetScheduled = true;
        
        // Schedule reset for next day start
        const [startHour, startMinute] = user.config.dayStart.split(':').map(Number);
        const resetTime = new Date();
        resetTime.setDate(resetTime.getDate() + 1);
        resetTime.setHours(startHour, startMinute, 0, 0);
        
        const delay = resetTime.getTime() - now.getTime();
        
        setTimeout(() => {
            resetDailyCounters(userId);
        }, delay);
    }
}

function resetDailyCounters(userId) {
    const user = globalState.users[userId];
    if (user) {
        user.spinnerStats.spinsToday = 0;
        user.achievementStats.claimedToday = 0;
        user.dailyResetScheduled = false;
        logActivity(userId, 'Daily counters reset');
        saveState();
    }
}

function calculateNextSpinTime(userId) {
    const user = globalState.users[userId];
    if (!user) return null;
    
    const baseIntervalMs = user.config.baseInterval * 60 * 1000;
    const randomAddMs = Math.floor(
        Math.random() * (user.config.randomScale2 - user.config.randomScale1) + user.config.randomScale1
    ) * 1000;
    
    const totalDelayMs = baseIntervalMs + randomAddMs;
    const nextSpin = new Date(Date.now() + totalDelayMs);
    
    return {
        nextSpin: nextSpin.toISOString(),
        baseInterval: user.config.baseInterval,
        randomAdd: randomAddMs / 1000,
        totalDelay: totalDelayMs / 1000
    };
}

// API request function with detailed logging
async function sendAPIRequest(userId, url, method = 'GET', headers = {}, data = null) {
    const requestConfig = {
        url: url,
        method: method,
        headers: headers,
        data: data
    };

    if (CONFIG.DEBUG_MODE) {
        logActivity(userId, `API Request: ${method} ${url}`, 'debug');
        if (data) {
            logActivity(userId, `Request Data: ${JSON.stringify(data)}`, 'debug');
        }
    }

    try {
        let response;
        
        if (CONFIG.PROXY_URL && CONFIG.PROXY_URL !== 'direct') {
            response = await axios.post(CONFIG.PROXY_URL, requestConfig, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
        } else {
            response = await axios(requestConfig);
        }
        
        if (CONFIG.DEBUG_MODE) {
            logActivity(userId, `API Response: ${response.status}`, 'debug');
            logActivity(userId, `Response Data: ${JSON.stringify(response.data)}`, 'debug');
        }
        
        return {
            success: true,
            status: response.status,
            data: response.data
        };
    } catch (error) {
        logActivity(userId, `API Request Failed: ${error.message}`, 'error');
        
        if (error.response) {
            if (CONFIG.DEBUG_MODE) {
                logActivity(userId, `Error Response: ${JSON.stringify(error.response.data)}`, 'debug');
            }
            return {
                success: false,
                status: error.response.status,
                error: error.message,
                data: error.response.data
            };
        } else {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// BLOCK 1: JWT Token Refresher
async function refreshJWTToken(userId) {
    const user = globalState.users[userId];
    if (!user) {
        logActivity(userId, 'User not found in configuration', 'error');
        return { success: false, error: 'User not configured' };
    }
    
    logActivity(userId, 'Starting JWT token refresh...');
    
    const headers = {
        'Content-Type': 'application/json'
    };
    
    const requestData = {
        refreshToken: user.refreshToken
    };
    
    const refreshUrl = `${CONFIG.API_BASE_URL}/v1/auth/refresh-jwt`;
    
    const result = await sendAPIRequest(userId, refreshUrl, 'POST', headers, requestData);
    
    if (result.success && result.data && result.data.data) {
        const newJWT = result.data.data.jwt;
        const newRefreshToken = result.data.data.refreshToken;
        
        // Update user state
        user.currentJWT = newJWT;
        user.lastRefresh = new Date().toISOString();
        
        // Calculate expiry (assuming 24 hours)
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + 24);
        user.jwtExpiry = expiry.toISOString();
        
        // Update refresh token if provided
        if (newRefreshToken && newRefreshToken !== 'Not provided') {
            user.refreshToken = newRefreshToken;
            logActivity(userId, 'Refresh token updated');
        }
        
        logActivity(userId, `JWT token refreshed successfully. Expires: ${user.jwtExpiry}`);
        saveState();
        return { success: true, jwt: newJWT };
    } else {
        logActivity(userId, `JWT refresh failed: ${result.error}`, 'error');
        return { success: false, error: result.error };
    }
}

// BLOCK 2: Achievements and Funds Checker
async function checkAndClaimAchievements(userId) {
    const user = globalState.users[userId];
    if (!user || !user.currentJWT) {
        logActivity(userId, 'No JWT token available for achievements check', 'error');
        return;
    }
    
    logActivity(userId, 'Starting achievements check and claim...');
    
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': user.currentJWT
    };
    
    try {
        // Step 1: Get achievements data
        const achievementsUrl = `${CONFIG.API_BASE_URL}/v1/achievements/${user.config.userId}/user`;
        const achievementsResult = await sendAPIRequest(userId, achievementsUrl, 'GET', headers);
        
        if (!achievementsResult.success) {
            logActivity(userId, `Failed to fetch achievements: ${achievementsResult.error}`, 'error');
            return;
        }
        
        const validIDs = [];
        const responseData = achievementsResult.data;
        
        // Collect claimable achievement IDs from all categories
        const categories = ['achievements', 'daily', 'weekly', 'monthly'];
        categories.forEach(category => {
            if (responseData.data[category]) {
                responseData.data[category].forEach(item => {
                    if (item.progress && item.progress.claimAvailable) {
                        validIDs.push(item.id);
                    }
                });
            }
        });
        
        logActivity(userId, `Found ${validIDs.length} claimable achievements`);
        
        // Step 2: Claim achievements
        let claimedCount = 0;
        const batchSize = 5;
        
        for (let i = 0; i < validIDs.length; i += batchSize) {
            const batch = validIDs.slice(i, i + batchSize);
            const promises = batch.map(id => 
                sendAPIRequest(
                    userId,
                    `${CONFIG.API_BASE_URL}/v1/achievements/${id}/claim/`,
                    'POST',
                    headers
                )
            );
            
            const results = await Promise.all(promises);
            
            results.forEach((result, index) => {
                const id = batch[index];
                if (result.success) {
                    claimedCount++;
                    logActivity(userId, `Claimed achievement ID: ${id}`);
                } else {
                    logActivity(userId, `Failed to claim achievement ID: ${id} - ${result.error}`, 'error');
                }
            });
            
            // Delay between batches
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Update statistics
        user.achievementStats.totalClaimed += claimedCount;
        user.achievementStats.claimedToday += claimedCount;
        user.achievementStats.lastCheck = new Date().toISOString();
        user.achievementStats.lastClaimed = validIDs.slice(0, 10);
        
        logActivity(userId, `Successfully claimed ${claimedCount} achievements`);
        saveState();
        
    } catch (error) {
        logActivity(userId, `Error in achievements check: ${error.message}`, 'error');
    }
}

async function checkFunds(userId) {
    const user = globalState.users[userId];
    if (!user || !user.currentJWT) {
        logActivity(userId, 'No JWT token available for funds check', 'error');
        return;
    }
    
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': user.currentJWT
    };
    
    const fundsUrl = `${CONFIG.API_BASE_URL}/v1/user/funds`;
    
    const result = await sendAPIRequest(userId, fundsUrl, 'GET', headers);
    
    if (result.success && result.data && result.data.data) {
        const silvercoins = result.data.data.silvercoins;
        
        // Update user state
        user.fundStats.currentSilver = silvercoins;
        user.fundStats.lastUpdate = new Date().toISOString();
        
        // Add to history (keep last 50 entries)
        user.fundStats.history.unshift({
            timestamp: new Date().toISOString(),
            silvercoins: silvercoins
        });
        
        if (user.fundStats.history.length > 50) {
            user.fundStats.history = user.fundStats.history.slice(0, 50);
        }
        
        logActivity(userId, `Funds check: ${silvercoins.toLocaleString()} silver coins`);
        saveState();
        return { success: true, silvercoins };
    } else {
        logActivity(userId, `Funds check failed: ${result.error}`, 'error');
        return { success: false, error: result.error };
    }
}

// BLOCK 3: Spinner
async function performSpin(userId) {
    const user = globalState.users[userId];
    if (!user || !user.currentJWT) {
        logActivity(userId, 'No JWT token available for spin', 'error');
        return;
    }
    
    if (!isWithinActiveWindow(userId)) {
        logActivity(userId, 'Outside active window, skipping spin', 'warning');
        return;
    }
    
    logActivity(userId, 'Performing spin...');
    
    const headers = {
        'Content-Type': 'application/json',
        'x-user-jwt': user.currentJWT
    };
    
    const spinData = {
        spinnerId: 6799
    };
    
    const spinUrl = `${CONFIG.API_BASE_URL}/v1/spinner/spin?categoryId=1`;
    
    const result = await sendAPIRequest(userId, spinUrl, 'POST', headers, spinData);
    
    if (result.success && result.data) {
        const spinResult = result.data;
        const resultId = spinResult.data?.id;
        const resultName = getPrizeName(resultId);
        
        // Update statistics
        user.spinnerStats.totalSpins++;
        user.spinnerStats.spinsToday++;
        user.spinnerStats.lastSpin = new Date().toISOString();
        
        // Add to results (keep last 30)
        user.spinnerStats.spinResults.unshift({
            timestamp: new Date().toISOString(),
            resultId: resultId,
            resultName: resultName,
            fullResponse: spinResult
        });
        
        if (user.spinnerStats.spinResults.length > 30) {
            user.spinnerStats.spinResults = user.spinnerStats.spinResults.slice(0, 30);
        }
        
        // Calculate next spin time
        const nextSpinInfo = calculateNextSpinTime(userId);
        user.spinnerStats.nextSpin = nextSpinInfo.nextSpin;
        
        logActivity(userId, `Spin successful: ${resultName} (ID: ${resultId})`);
        logActivity(userId, `Next spin scheduled for: ${new Date(nextSpinInfo.nextSpin).toUTCString()}`);
        
        saveState();
        return { 
            success: true, 
            result: resultName,
            nextSpin: nextSpinInfo 
        };
    } else {
        logActivity(userId, `Spin failed: ${result.error}`, 'error');
        
        // Check if it's a JWT expiry error
        if (result.error && (result.error.includes('expired') || result.status === 401)) {
            logActivity(userId, 'JWT token might be expired, attempting refresh...', 'warning');
            await refreshJWTToken(userId);
        }
        
        return { success: false, error: result.error };
    }
}

function getPrizeName(prizeId) {
    const prizeMap = {
        11755: "5,000 Silvercoins",
        11750: "Core Standard Pack", 
        11749: "500 Silvercoins",
        11754: "1,000,000 Silvercoins",
        11753: "100,000 Silvercoins",
        11752: "2,500 Silvercoins",
        11751: "1,000 Silvercoins"
    };
    
    return prizeMap[prizeId] || `Unknown Prize (ID: ${prizeId})`;
}

// Scheduler functions for multiple users
function startDailyScheduleForUser(userId) {
    const user = globalState.users[userId];
    if (!user) return;
    
    logActivity(userId, 'Starting daily schedule...');
    user.isActive = true;
    
    // Schedule achievements checks (3 times per day)
    const achievementTimes = [
        `${parseInt(user.config.dayStart.split(':')[1])} ${parseInt(user.config.dayStart.split(':')[0])} * * *`, // 0 hour before start
        `${parseInt(user.config.dayStart.split(':')[1])} ${parseInt(user.config.dayStart.split(':')[0]) + 5} * * *`, // +5 hours after start
        `${parseInt(user.config.dayEnd.split(':')[1])} ${parseInt(user.config.dayEnd.split(':')[0])} * * *` // at end time
    ];
    
    achievementTimes.forEach((time, index) => {
        cron.schedule(time, async () => {
            logActivity(userId, `Scheduled achievements check #${index + 1}`);
            await checkAndClaimAchievements(userId);
        }, { timezone: "UTC" });
    });
    
    // Schedule funds checks (hourly during active window)
    cron.schedule('0 * * * *', async () => {
        if (isWithinActiveWindow(userId)) {
            logActivity(userId, 'Scheduled funds check');
            await checkFunds(userId);
        }
    }, { timezone: "UTC" });
    
    // Start spinner loop for this user
    startSpinnerLoopForUser(userId);
}

function startSpinnerLoopForUser(userId) {
    async function spinnerIteration() {
        const user = globalState.users[userId];
        if (!user || !user.isActive || !isWithinActiveWindow(userId)) {
            logActivity(userId, 'Spinner loop paused - outside active window or inactive');
            return;
        }
        
        if (!user.currentJWT) {
            logActivity(userId, 'No JWT token, refreshing...');
            const refreshResult = await refreshJWTToken(userId);
            if (!refreshResult.success) {
                logActivity(userId, 'Failed to refresh JWT, retrying in 5 minutes', 'error');
                setTimeout(spinnerIteration, 5 * 60 * 1000);
                return;
            }
        }
        
        await performSpin(userId);
        
        // Schedule next spin
        if (user.spinnerStats.nextSpin) {
            const nextSpinTime = new Date(user.spinnerStats.nextSpin).getTime();
            const delay = Math.max(0, nextSpinTime - Date.now());
            
            logActivity(userId, `Next spin in ${Math.round(delay / 1000 / 60)} minutes`);
            setTimeout(spinnerIteration, delay);
        } else {
            // Fallback: use default calculation
            const nextSpinInfo = calculateNextSpinTime(userId);
            const delay = nextSpinInfo.totalDelay * 1000;
            setTimeout(spinnerIteration, delay);
        }
    }
    
    // Start first iteration
    spinnerIteration();
}

// BLOCK 4: Display endpoints
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/status', (req, res) => {
    const userId = req.query.userId;
    
    if (userId && globalState.users[userId]) {
        // Return status for specific user
        const user = globalState.users[userId];
        res.json({
            userId: userId,
            system: {
                status: user.isActive ? 'active' : 'inactive',
                currentTime: new Date().toISOString(),
                withinActiveWindow: isWithinActiveWindow(userId),
                activeWindow: `${user.config.dayStart} - ${user.config.dayEnd} UTC`
            },
            authentication: {
                hasJWT: !!user.currentJWT,
                lastRefresh: user.lastRefresh,
                jwtExpiry: user.jwtExpiry
            },
            statistics: {
                spinner: user.spinnerStats,
                achievements: user.achievementStats,
                funds: user.fundStats
            },
            config: user.config
        });
    } else {
        // Return status for all users
        const usersStatus = {};
        Object.keys(globalState.users).forEach(userId => {
            const user = globalState.users[userId];
            usersStatus[userId] = {
                system: {
                    status: user.isActive ? 'active' : 'inactive',
                    withinActiveWindow: isWithinActiveWindow(userId),
                    activeWindow: `${user.config.dayStart} - ${user.config.dayEnd} UTC`
                },
                authentication: {
                    hasJWT: !!user.currentJWT,
                    lastRefresh: user.lastRefresh
                },
                statistics: {
                    spinner: {
                        totalSpins: user.spinnerStats.totalSpins,
                        spinsToday: user.spinnerStats.spinsToday,
                        lastSpin: user.spinnerStats.lastSpin,
                        nextSpin: user.spinnerStats.nextSpin
                    },
                    achievements: {
                        totalClaimed: user.achievementStats.totalClaimed,
                        claimedToday: user.achievementStats.claimedToday,
                        lastCheck: user.achievementStats.lastCheck
                    },
                    funds: {
                        currentSilver: user.fundStats.currentSilver,
                        lastUpdate: user.fundStats.lastUpdate
                    }
                }
            };
        });
        
        res.json({
            system: {
                currentTime: new Date().toISOString(),
                totalUsers: Object.keys(globalState.users).length,
                activeUsers: Object.keys(globalState.users).filter(id => globalState.users[id].isActive).length
            },
            users: usersStatus
        });
    }
});

app.get('/api/activity', (req, res) => {
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 50;
    
    if (userId && globalState.users[userId]) {
        res.json(globalState.users[userId].activityLog.slice(0, limit));
    } else {
        // Return combined activity from all users
        const allActivity = [];
        Object.keys(globalState.users).forEach(userId => {
            allActivity.push(...globalState.users[userId].activityLog.slice(0, limit));
        });
        
        // Sort by timestamp and limit
        allActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json(allActivity.slice(0, limit));
    }
});

app.post('/api/refresh-token', async (req, res) => {
    const userId = req.body.userId;
    if (!userId || !globalState.users[userId]) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    const result = await refreshJWTToken(userId);
    res.json(result);
});

app.post('/api/check-funds', async (req, res) => {
    const userId = req.body.userId;
    if (!userId || !globalState.users[userId]) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    const result = await checkFunds(userId);
    res.json(result);
});

app.post('/api/check-achievements', async (req, res) => {
    const userId = req.body.userId;
    if (!userId || !globalState.users[userId]) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    await checkAndClaimAchievements(userId);
    res.json({ message: 'Achievements check completed' });
});

app.post('/api/manual-spin', async (req, res) => {
    const userId = req.body.userId;
    if (!userId || !globalState.users[userId]) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    const result = await performSpin(userId);
    res.json(result);
});

app.get('/api/users', (req, res) => {
    res.json(Object.keys(globalState.users));
});

// Initialize and start the tool for all users
async function initializeTool() {
    logActivity('SYSTEM', 'Initializing MegaTool...');
    loadState();
    
    // Initialize each user
    for (const userId of Object.keys(globalState.users)) {
        const user = globalState.users[userId];
        
        logActivity(userId, 'Initializing user...');
        
        // Get initial JWT token
        const refreshResult = await refreshJWTToken(userId);
        
        if (refreshResult.success) {
            logActivity(userId, 'Initial JWT token obtained successfully');
            
            // Initial funds check
            await checkFunds(userId);
            
            // Start scheduled tasks
            startDailyScheduleForUser(userId);
            
            logActivity(userId, 'User initialized and running');
        } else {
            logActivity(userId, 'Failed to get initial JWT token. User cannot start.', 'error');
        }
    }
    
    logActivity('SYSTEM', `MegaTool initialized for ${Object.keys(globalState.users).length} users`);
}

// Start server
app.listen(PORT, () => {
    console.log(`MegaTool running on port ${PORT}`);
    initializeTool();
});

// Graceful shutdown
process.on('SIGINT', () => {
    logActivity('SYSTEM', 'Shutting down MegaTool...');
    saveState();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logActivity('SYSTEM', 'Shutting down MegaTool...');
    saveState();
    process.exit(0);
});
