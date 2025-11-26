const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple logging
const debugLogs = [];

function debugLog(userId, action, url, method, data = null, response = null, error = null) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        action,
        request: { url, method, body: data },
        response: response ? { status: response.status, data: response.data } : null,
        error: error ? { message: error.message, status: error.response?.status } : null
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop();

    console.log(`[${debugEntry.timestamp}] ${userId}: ${action} - ${url}`);
}

// Configuration
const CONFIG = {
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_SPIN: process.env.BASE_URL_SPIN,
    BASE_URL_BUY_SPIN: process.env.BASE_URL_BUY_SPIN,
    BASE_URL_OPENPACK: process.env.BASE_URL_OPENPACK,
    USERS_FILE: 'users.json',
};

// Global storage
let userData = {};

// Load user configuration
async function loadUserConfig() {
    try {
        const configData = await fs.readFile(CONFIG.USERS_FILE, 'utf8');
        const users = JSON.parse(configData);
        
        for (const user of users) {
            userData[user.userId] = {
                ...user,
                jwtToken: null,
                isActive: false,
                spinCount: 0,
                packsOpened: 0,
                lastError: null,
                logs: []
            };
        }
        console.log(`✅ Loaded ${users.length} users`);
    } catch (error) {
        console.error('❌ Error loading user config:', error);
        userData = {};
    }
}

// API request function
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    try {
        debugLog(userId, 'REQUEST', url, method, data);
        
        const response = await axios({
            method: method.toLowerCase(),
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data,
            timeout: 10000
        });

        debugLog(userId, 'SUCCESS', url, method, data, response);
        return { success: true, data: response.data, status: response.status };
        
    } catch (error) {
        debugLog(userId, 'ERROR', url, method, data, null, error);
        return {
            success: false,
            error: error.message,
            status: error.response?.status
        };
    }
}

// Refresh token
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) return false;

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_REF, 
        'POST', 
        { 'Content-Type': 'application/json' },
        { refreshToken: user.refreshToken },
        userId
    );

    if (result.success && result.data.data?.jwt) {
        user.jwtToken = result.data.data.jwt;
        user.isActive = true;
        logActivity(userId, '✅ Token refreshed');
        return true;
    } else {
        user.isActive = false;
        logActivity(userId, `❌ Token refresh failed: ${result.error}`);
        return false;
    }
}

// Buy spin
async function buySpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (result.success) {
        logActivity(userId, '✅ Spin purchased');
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await buySpin(userId);
    }
    
    logActivity(userId, `❌ Spin purchase failed: ${result.error}`);
    return false;
}

// Open pack
async function openPack(userId, packId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_OPENPACK,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { packId },
        userId
    );

    if (result.success) {
        user.packsOpened++;
        logActivity(userId, `✅ Pack opened: ${packId}`);
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await openPack(userId, packId);
    }
    
    logActivity(userId, `❌ Pack open failed: ${result.error}`);
    return false;
}

// Execute spin
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) {
        logActivity(userId, '❌ No JWT token');
        return null;
    }

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { spinnerId: 6799 },
        userId
    );

    if (!result.success) {
        if (result.status === 401) {
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) return await executeSpin(userId);
        }
        logActivity(userId, `❌ Spin failed: ${result.error}`);
        return null;
    }

    const spinData = result.data.data;
    const resultId = spinData.id;
    user.spinCount++;

    // Check if we got a pack (IDs: 11848, 11782, 11750)
    if ([11848, 11782, 11750].includes(resultId) && spinData.packs && spinData.packs.length > 0) {
        const packId = spinData.packs[0].id;
        logActivity(userId, `🎁 Got pack from spin: ${packId}`);
        await openPack(userId, packId);
    } else {
        logActivity(userId, `🎰 Spin result: ${resultId}`);
    }

    return resultId;
}

// Main spin loop
async function startSpinLoop(userId) {
    const user = userData[userId];
    if (!user) return;

    logActivity(userId, '🚀 Starting spin loop');

    while (user.isActive) {
        try {
            // Buy spin
            const buySuccess = await buySpin(userId);
            if (!buySuccess) {
                user.lastError = 'Failed to buy spin';
                break;
            }

            // Wait 7 seconds
            await new Promise(resolve => setTimeout(resolve, 7000));

            // Execute spin
            const spinResult = await executeSpin(userId);
            if (spinResult === null) {
                user.lastError = 'Failed to execute spin';
                break;
            }

            // Wait 7 seconds before next iteration
            await new Promise(resolve => setTimeout(resolve, 7000));

        } catch (error) {
            if (error.response?.status === 429) {
                logActivity(userId, '⏳ Rate limited, waiting 20 seconds');
                await new Promise(resolve => setTimeout(resolve, 20000));
            } else if (error.response?.status === 403) {
                logActivity(userId, '❌ User suspended, stopping');
                user.isActive = false;
                break;
            } else {
                logActivity(userId, `⚠️ Error in spin loop: ${error.message}`);
                // Continue despite other errors
            }
        }
    }

    logActivity(userId, '🛑 Spin loop stopped');
}

// Initialize and start all users
async function initializeApp() {
    try {
        console.log('🚀 Initializing application...');
        await loadUserConfig();
        
        // Refresh tokens for all users
        console.log('🔄 Refreshing tokens...');
        for (const userId of Object.keys(userData)) {
            await refreshToken(userId);
        }

        // Start spin loops after 20 seconds
        console.log('⏳ Starting spin loops in 20 seconds...');
        setTimeout(() => {
            Object.keys(userData).forEach(userId => {
                if (userData[userId].isActive) {
                    startSpinLoop(userId);
                }
            });
        }, 20000);

    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

// Activity logging
function logActivity(userId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message };

    debugLogs.unshift(logEntry);
    if (userData[userId]) {
        userData[userId].logs.unshift(logEntry);
        userData[userId].logs = userData[userId].logs.slice(0, 100);
    }

    console.log(`[${timestamp}] ${userId}: ${message}`);
}

// Safe user data for frontend
function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        out[id] = {
            userId: u.userId,
            isActive: u.isActive,
            spinCount: u.spinCount,
            packsOpened: u.packsOpened,
            lastError: u.lastError,
            logs: u.logs.slice(0, 20)
        };
    }
    return out;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/users', (req, res) => {
    res.json(safeUsersSnapshot());
});

app.get('/api/debug-logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(debugLogs.slice(0, limit));
});

// Manual control endpoints
app.post('/api/user/:userId/refresh', async (req, res) => {
    const userId = req.params.userId;
    const success = await refreshToken(userId);
    res.json({ success });
});

app.post('/api/user/:userId/start', async (req, res) => {
    const userId = req.params.userId;
    if (userData[userId] && userData[userId].isActive) {
        startSpinLoop(userId);
        res.json({ success: true, message: 'Spin loop started' });
    } else {
        res.json({ success: false, message: 'User not active' });
    }
});

app.post('/api/user/:userId/stop', (req, res) => {
    const userId = req.params.userId;
    if (userData[userId]) {
        userData[userId].isActive = false;
        res.json({ success: true, message: 'Spin loop stopped' });
    } else {
        res.json({ success: false, message: 'User not found' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    initializeApp();
});
