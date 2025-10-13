const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 🎯 ENHANCED DEBUGGING - You'll see EVERYTHING in console AND browser!
const debugLogs = [];

function debugLog(userId, action, url, method, headers = {}, data = null, response = null, error = null) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        action,
        request: {
            url,
            method,
            headers: JSON.stringify(headers, null, 2),
            body: data ? JSON.stringify(data, null, 2) : null
        },
        response: response ? {
            status: response.status,
            data: JSON.stringify(response.data, null, 2)
        } : null,
        error: error ? {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null
        } : null
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop(); // Keep last 200 debug entries

    console.log('\n' + '='.repeat(80));
    console.log(`🔍 DEBUG [${debugEntry.timestamp}] - USER: ${userId}`);
    console.log(`📝 ACTION: ${action}`);
    console.log(`📡 REQUEST:`);
    console.log(`   URL: ${url}`);
    console.log(`   METHOD: ${method}`);
    console.log(`   HEADERS:`, JSON.stringify(headers, null, 2));
    if (data) console.log(`   BODY:`, JSON.stringify(data, null, 2));
    
    if (response) {
        console.log(`✅ RESPONSE:`);
        console.log(`   STATUS: ${response.status}`);
        console.log(`   DATA:`, JSON.stringify(response.data, null, 2));
    }
    
    if (error) {
        console.log(`❌ ERROR:`);
        console.log(`   MESSAGE: ${error.message}`);
        if (error.response) {
            console.log(`   STATUS: ${error.response.status}`);
            console.log(`   RESPONSE DATA:`, JSON.stringify(error.response.data, null, 2));
        }
    }
    console.log('='.repeat(80) + '\n');
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// 🎯 SIMPLE CONFIGURATION
const CONFIG = {
    BASE_URL: process.env.BASE_URL,
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_MONEY: process.env.BASE_URL_MONEY,
    BASE_URL_SPRAY: process.env.BASE_URL_SPRAY,
    BASE_URL_ACH: process.env.BASE_URL_ACH,
	//PORT = process.env.PORT || 3000;
    USERS_FILE: 'users.json',
};

const BASE_URL = CONFIG.BASE_URL;
const BASE_URL_REF = CONFIG.BASE_URL_REF;
const BASE_URL_MONEY = CONFIG.BASE_URL_MONEY;
const BASE_URL_SPRAY = CONFIG.BASE_URL_SPRAY;
const BASE_URL_ACH = CONFIG.BASE_URL_ACH;
const USERS_CONFIG = CONFIG.USERS_FILE;

// Global storage for user data and logs
let userData = {};
let activityLogs = [];

// Initialize the application
async function initializeApp() {
    try {
        console.log('🚀 INITIALIZING APPLICATION...');
        
        // Load user configuration
        await loadUserConfig();
        
        // Refresh tokens for ALL users at startup
        console.log('🔄 REFRESHING TOKENS FOR ALL USERS AT STARTUP...');
        for (const userId of Object.keys(userData)) {
            await refreshToken(userId);
        }
        
        console.log('✅ Application initialized successfully');
        
        // Start operations immediately after token refresh
        startImmediateOperations();
        
        // Start scheduled tasks
        startScheduledTasks();
        
        // Start continuous operations
        startContinuousOperations();
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
    }
}

// Start immediate operations after token refresh
function startImmediateOperations() {
    console.log('🎯 STARTING IMMEDIATE OPERATIONS...');
    
    // Give it 1 minute for JWT to be fully ready, then start achievements and funds
    setTimeout(() => {
        Object.keys(userData).forEach((userId) => {
            const user = userData[userId];
            if (user.isActive && isWithinActiveWindow(userId)) {
                logActivity(userId, '🚀 Starting immediate operations after startup');
                
                // First achievements claim (immediately after startup)
                claimAchievements(userId);
                
                // First funds check
                checkFunds(userId);
                
                // Schedule first spin if within active window
                if (!user.nextSpinTime) {
                    calculateNextSpinTime(userId);
                }
            }
        });
    }, 60000); // 1 minute delay
}

// Load user configuration from file
async function loadUserConfig() {
    try {
        const configData = await fs.readFile(USERS_CONFIG, 'utf8');
        const users = JSON.parse(configData);
        
        for (const user of users) {
            userData[user.userId] = {
                ...user,
                jwtToken: null,
                lastRefresh: null,
                nextSpinTime: null,
                spinCount: 0,
                achievementsClaimed: 0,
                lastFunds: 0,
                logs: [],
                isActive: false,
                dailyAchievementsDone: false,
                dailyFundsChecks: 0
            };
        }
        console.log(`✅ Loaded configuration for ${users.length} users`);
    } catch (error) {
        console.error('❌ Error loading user config:', error);
        userData = {};
    }
}

// API request function with error handling
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    try {
        debugLog(userId, 'SENDING_REQUEST', url, method, headers, data);
        
        const response = await axios({
            method: method.toLowerCase(),
            url: url,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            data: data,
            timeout: 10000
        });

        debugLog(userId, 'REQUEST_SUCCESS', url, method, headers, data, response);
        return { success: true, data: response.data, status: response.status };
        
    } catch (error) {
        debugLog(userId, 'REQUEST_ERROR', url, method, headers, data, null, error);
        return {
            success: false,
            error: error.message,
            status: error.response?.status,
            responseData: error.response?.data
        };
    }
}

// BLOCK 1: Token Refresher
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) {
        logActivity(userId, 'ERROR: User not found in configuration');
        return false;
    }

    const refreshEndpoint = `${BASE_URL_REF}`;
    const headers = {
        'Content-Type': 'application/json',
    };
    const requestData = {
        refreshToken: user.refreshToken,
    };

    logActivity(userId, 'Starting token refresh...');
    const result = await makeAPIRequest(refreshEndpoint, 'POST', headers, requestData, userId);

    if (result.success && result.data.data?.jwt) {
        const newJWT = result.data.data.jwt;
        const newRefreshToken = result.data.data?.refreshToken;

        user.jwtToken = newJWT;
        user.lastRefresh = new Date().toISOString();
        user.isActive = true;

        // Update refresh token if provided
        if (newRefreshToken && newRefreshToken !== 'Not provided') {
            user.refreshToken = newRefreshToken;
            await updateUserConfig(userId, 'refreshToken', newRefreshToken);
        }

        logActivity(userId, '✅ Token refresh successful. New JWT stored.');
        
        // Schedule next token refresh at user's dayStart time
        scheduleNextTokenRefresh(userId);
        
        return true;
    } else {
        logActivity(userId, `❌ Token refresh failed: ${result.error}`);
        user.isActive = false;
        return false;
    }
}

// Schedule next token refresh at user's dayStart time
function scheduleNextTokenRefresh(userId) {
    const user = userData[userId];
    if (!user) return;

    const now = new Date();
    const [startHour, startMinute] = user.dayStart.split(':').map(Number);
    
    // Calculate next refresh time (tomorrow at dayStart)
    const nextRefresh = new Date();
    nextRefresh.setDate(nextRefresh.getDate() + 1);
    nextRefresh.setHours(startHour, startMinute, 0, 0);
    
    const delay = nextRefresh.getTime() - now.getTime();
    
    setTimeout(() => {
        logActivity(userId, '🔄 Scheduled daily token refresh');
        refreshToken(userId);
    }, delay);
    
    logActivity(userId, `⏰ Next token refresh scheduled for: ${nextRefresh.toUTCString()}`);
}

// BLOCK 2: Check Funds and Claim Achievements
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for funds check');
        return null;
    }

    const fundsUrl = `${BASE_URL_MONEY}`;
    const headers = {
        'x-user-jwt': user.jwtToken,
    };

    const result = await makeAPIRequest(fundsUrl, 'GET', headers, null, userId);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.lastFunds = silvercoins;
        user.dailyFundsChecks = (user.dailyFundsChecks || 0) + 1;
        logActivity(userId, `💰 Funds: ${silvercoins.toLocaleString()} silvercoins`);
        return silvercoins;
    } else {
        if (result.status === 401) {
            logActivity(userId, 'JWT expired during funds check, attempting refresh...');
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) {
                return await checkFunds(userId);
            }
        }
        logActivity(userId, `❌ Funds check failed: ${result.error}`);
        return null;
    }
}

async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for achievements');
        return 0;
    }

    let totalClaimed = 0;
    const userAchievementsUrl = `${BASE_URL_ACH}/${user.userClaimAchivID}/user`;
    const headers = {
        'x-user-jwt': user.jwtToken,
    };

    logActivity(userId, '🎯 Starting achievements claim process...');

    try {
        // Get available achievements
        const achievementsResult = await makeAPIRequest(userAchievementsUrl, 'GET', headers, null, userId);
        
        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                logActivity(userId, 'JWT expired during achievements check, attempting refresh...');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    return await claimAchievements(userId);
                }
            }
            logActivity(userId, `❌ Achievements check failed: ${achievementsResult.error}`);
            return 0;
        }

        const validIDs = [];
        const categories = ['achievements', 'daily', 'weekly', 'monthly'];

        // Collect claimable achievement IDs
        categories.forEach((category) => {
            if (achievementsResult.data.data[category]) {
                achievementsResult.data.data[category].forEach((item) => {
                    if (item.progress?.claimAvailable) {
                        validIDs.push(item.id);
                    }
                });
            }
        });

        if (validIDs.length === 0) {
            logActivity(userId, 'ℹ️ No achievements available to claim');
            return 0;
        }

        logActivity(userId, `🎯 Found ${validIDs.length} achievements to claim`);

        // Claim achievements in batches
        const batchSize = 3;
        for (let i = 0; i < validIDs.length; i += batchSize) {
            const batch = validIDs.slice(i, i + batchSize);
            
            for (const achievementId of batch) {
                const claimUrl = `${BASE_URL_ACH}/${achievementId}/claim/`;
                const claimResult = await makeAPIRequest(claimUrl, 'POST', headers, null, userId);
                
                if (claimResult.success) {
                    totalClaimed++;
                    logActivity(userId, `✅ Claimed achievement ID: ${achievementId}`);
                } else {
                    logActivity(userId, `❌ Failed to claim achievement ${achievementId}: ${claimResult.error}`);
                }
                
                // Small delay between claims
                await new Promise((resolve) => setTimeout(resolve, 800));
            }
            
            // Delay between batches
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        user.achievementsClaimed += totalClaimed;
        logActivity(userId, `🎉 Successfully claimed ${totalClaimed} achievements`);
        return totalClaimed;

    } catch (error) {
        logActivity(userId, `❌ Error in achievements process: ${error.message}`);
        return 0;
    }
}

// BLOCK 3: Spinner Functionality - FIXED: Always schedule next spin even on error
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for spin');
        // Still schedule next spin even if no JWT
        calculateNextSpinTime(userId);
        return null;
    }

    if (!isWithinActiveWindow(userId)) {
        logActivity(userId, '⏰ Outside active window, skipping spin');
        return null;
    }

    logActivity(userId, '🎰 Executing free spin...');

    let spinSuccess = false;
    let prizeName = 'Unknown';

    try {
        const spinUrl = `${BASE_URL_SPRAY}`;
        const headers = {
            'x-user-jwt': user.jwtToken,
            'Content-Type': 'application/json',
        };

        const spinResult = await makeAPIRequest(spinUrl, 'POST', headers, { spinnerId: 6799 }, userId);

        if (!spinResult.success) {
            if (spinResult.status === 401) {
                logActivity(userId, 'JWT expired during spin, attempting refresh...');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    // Don't retry the spin, just continue with scheduling
                    logActivity(userId, '🔄 JWT refreshed, but not retrying spin. Scheduling next spin.');
                }
            }
            // Log the error but don't throw - we'll continue with scheduling
            logActivity(userId, `⚠️ Spin failed: ${spinResult.error} - Continuing with schedule`);
        } else {
            const spinData = spinResult.data.data;
            const resultId = spinData.id;

            // Prize mapping
            const prizeMap = {
                11755: '5,000 Silvercoins',
                11750: 'Core Standard Pack',
                11749: '500 Silvercoins',
                11754: '1,000,000 Silvercoins',
                11753: '100,000 Silvercoins',
                11752: '2,500 Silvercoins',
                11751: '1,000 Silvercoins',
            };

            prizeName = prizeMap[resultId] || `ID = ${resultId}`;
            user.spinCount++;
            spinSuccess = true;
            
            logActivity(userId, `🎉 Spin successful! Received: ${prizeName}`);
        }

    } catch (error) {
        logActivity(userId, `❌ Spin error: ${error.message} - Continuing with schedule`);
    } finally {
        // ALWAYS schedule next spin regardless of success/failure
        calculateNextSpinTime(userId);
    }

    return spinSuccess ? prizeName : null;
}

// Calculate next spin time with randomization - FIXED VERSION
function calculateNextSpinTime(userId) {
    const user = userData[userId];
    if (!user) return null;

    // Convert base interval from minutes to milliseconds
    const baseIntervalMs = user.baseInterval * 60 * 1000;
    
    // Convert random scale from minutes to milliseconds and randomize within that range
    const randomScale1Ms = user.randomScale1 * 60 * 1000;
    const randomScale2Ms = user.randomScale2 * 60 * 1000;
    
    const randomAddMs = Math.floor(
        Math.random() * (randomScale2Ms - randomScale1Ms) + randomScale1Ms
    );

    const totalDelayMs = baseIntervalMs + randomAddMs;
    const nextSpinTime = new Date(Date.now() + totalDelayMs);
    user.nextSpinTime = nextSpinTime.toISOString();

    logActivity(
        userId,
        `⏰ Next spin in ${Math.round(totalDelayMs / 1000 / 60)} minutes (at ${nextSpinTime.toUTCString()})`
    );

    return nextSpinTime;
}

// Check if current time is within user's active window
function isWithinActiveWindow(userId) {
    const user = userData[userId];
    if (!user) return false;

    const now = new Date();
    const currentUTC = now.getUTCHours() * 60 + now.getUTCMinutes();
    const dayStart = timeToMinutes(user.dayStart);
    const dayEnd = timeToMinutes(user.dayEnd);

    return currentUTC >= dayStart && currentUTC <= dayEnd;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

// Update user configuration file
async function updateUserConfig(userId, field, value) {
    try {
        const configData = await fs.readFile(USERS_CONFIG, 'utf8');
        const users = JSON.parse(configData);
        const userIndex = users.findIndex((u) => u.userId === userId);
        
        if (userIndex !== -1) {
            users[userIndex][field] = value;
            await fs.writeFile(USERS_CONFIG, JSON.stringify(users, null, 2));
        }
    } catch (error) {
        console.error('Error updating user config:', error);
    }
}

// Activity logging
function logActivity(userId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message };

    activityLogs.unshift(logEntry);
    activityLogs = activityLogs.slice(0, 1000);

    if (userData[userId]) {
        userData[userId].logs.unshift(logEntry);
        userData[userId].logs = userData[userId].logs.slice(0, 200);
    }

    console.log(`[${timestamp}] User ${userId}: ${message}`);
}

// Continuous operations for each user
function startContinuousOperations() {
    console.log('🚀 Starting continuous operations for all users...');
    
    // Spin operations - check every 30 seconds
    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            const user = userData[userId];
            
            if (!user.isActive || !isWithinActiveWindow(userId)) {
                continue;
            }

            // Execute spin if it's time or no next spin time is set
            if (!user.nextSpinTime || new Date() >= new Date(user.nextSpinTime)) {
                await executeSpin(userId);
                // Note: executeSpin now always schedules next spin internally
            }
        }
    }, 30000);

    // Funds check during active windows - every hour
    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            if (isWithinActiveWindow(userId) && userData[userId].isActive) {
                await checkFunds(userId);
            }
        }
    }, 60 * 60 * 1000);
}

// Schedule achievements based on server start time
function scheduleAchievementsFromStart() {
    console.log('⏰ Scheduling achievements based on server start time...');
    
    Object.keys(userData).forEach((userId) => {
        const user = userData[userId];
        if (user.isActive) {
            // Achievement 1: Immediately (already done in startImmediateOperations)
            // Achievement 2: +5.5 hours from now
            setTimeout(() => {
                if (isWithinActiveWindow(userId) && user.isActive) {
                    logActivity(userId, '🔄 Second scheduled achievements check (+5.5 hours)');
                    claimAchievements(userId);
                }
            }, 5.5 * 60 * 60 * 1000);
            
            // Achievement 3: At end of day
            scheduleEndOfDayAchievements(userId);
        }
    });
}

// Schedule end-of-day achievements
function scheduleEndOfDayAchievements(userId) {
    const user = userData[userId];
    if (!user) return;

    const now = new Date();
    const [endHour, endMinute] = user.dayEnd.split(':').map(Number);
    
    // Calculate end of day time
    const endOfDay = new Date();
    endOfDay.setHours(endHour, endMinute, 0, 0);
    
    // If end of day is in the past, schedule for tomorrow
    if (endOfDay <= now) {
        endOfDay.setDate(endOfDay.getDate() + 1);
    }
    
    const delay = endOfDay.getTime() - now.getTime();
    
    setTimeout(() => {
        if (user.isActive) {
            logActivity(userId, '🔄 Third scheduled achievements check (end of day)');
            claimAchievements(userId);
            
            // Schedule next day's end-of-day achievements
            scheduleEndOfDayAchievements(userId);
        }
    }, delay);
    
    logActivity(userId, `⏰ End-of-day achievements scheduled for: ${endOfDay.toUTCString()}`);
}

// Scheduled Tasks
function startScheduledTasks() {
    console.log('⏰ Starting scheduled tasks...');

    // Schedule achievements based on server start time
    scheduleAchievementsFromStart();

    console.log('✅ Scheduled tasks started');
}

// API Routes for frontend
app.get('/api/users', (req, res) => {
    res.json(userData);
});

app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(activityLogs.slice(0, limit));
});

app.get('/api/user/:userId/activity', (req, res) => {
    const userId = req.params.userId;
    const user = userData[userId];
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    const limit = parseInt(req.query.limit) || 50;
    res.json(user.logs.slice(0, limit));
});

// Debug logs endpoint - For browser F12 debugging
app.get('/api/debug-logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(debugLogs.slice(0, limit));
});

// Manual trigger endpoints (for testing) - FIXED: No alert popups
app.post('/api/user/:userId/refresh', async (req, res) => {
    const userId = req.params.userId;
    const success = await refreshToken(userId);
    res.json({ success, message: success ? 'Token refreshed' : 'Refresh failed' });
});

app.post('/api/user/:userId/spin', async (req, res) => {
    const userId = req.params.userId;
    const result = await executeSpin(userId);
    res.json({ success: !!result, result });
});

app.post('/api/user/:userId/claim-achievements', async (req, res) => {
    const userId = req.params.userId;
    const claimed = await claimAchievements(userId);
    res.json({ success: claimed > 0, claimed });
});

app.post('/api/user/:userId/check-funds', async (req, res) => {
    const userId = req.params.userId;
    const funds = await checkFunds(userId);
    res.json({ success: funds !== null, funds });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    console.log(`🔍 Debug logs available at http://localhost:${PORT}/api/debug-logs`);
    initializeApp();
});
