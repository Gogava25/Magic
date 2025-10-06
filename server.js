const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Environment variables (to be set in render.com)
const BASE_URL = process.env.BASE_URL;
const USERS_CONFIG = process.env.USERS_CONFIG || 'users.json';

// Global storage for user data and logs
let userData = {};
let activityLogs = [];

// Initialize the application
async function initializeApp() {
    try {
        // Load user configuration
        await loadUserConfig();
        console.log('Application initialized successfully');
        
        // Start scheduled tasks
        startScheduledTasks();
    } catch (error) {
        console.error('Failed to initialize application:', error);
    }
}

// Load user configuration from file or environment
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
                logs: []
            };
        }
        console.log(`Loaded configuration for ${users.length} users`);
    } catch (error) {
        console.error('Error loading user config:', error);
        // Create default structure if file doesn't exist
        userData = {};
    }
}

// API request function with error handling
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null) {
    try {
        const config = {
            method: method.toLowerCase(),
            url: url,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            timeout: 10000
        };

        if (data) {
            config.data = data;
        }

        const response = await axios(config);
        return { success: true, data: response.data };
    } catch (error) {
        console.error(`API request failed: ${error.message}`);
        return { 
            success: false, 
            error: error.message,
            status: error.response?.status
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

    const refreshEndpoint = `${BASE_URL}/v1/auth/refresh-jwt`;
    const headers = {
        'Content-Type': 'application/json'
    };
    
    const requestData = {
        refreshToken: user.refreshToken
    };

    logActivity(userId, 'Starting token refresh...');

    const result = await makeAPIRequest(refreshEndpoint, 'POST', headers, requestData);

    if (result.success) {
        const newJWT = result.data.data?.jwt;
        const newRefreshToken = result.data.data?.refreshToken;

        if (newJWT) {
            user.jwtToken = newJWT;
            user.lastRefresh = new Date().toISOString();
            
            // Update refresh token if provided
            if (newRefreshToken) {
                user.refreshToken = newRefreshToken;
                await updateUserConfig(userId, 'refreshToken', newRefreshToken);
            }
            
            logActivity(userId, `Token refresh successful. New JWT stored.`);
            return true;
        } else {
            logActivity(userId, 'ERROR: No JWT token in response');
            return false;
        }
    } else {
        logActivity(userId, `Token refresh failed: ${result.error}`);
        return false;
    }
}

// BLOCK 2: Check Funds and Claim Achievements
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for funds check');
        return null;
    }

    const fundsUrl = `${BASE_URL}/v1/user/funds`;
    const headers = {
        'x-user-jwt': user.jwtToken
    };

    const result = await makeAPIRequest(fundsUrl, 'GET', headers);

    if (result.success) {
        const silvercoins = result.data.data?.silvercoins || 0;
        user.lastFunds = silvercoins;
        logActivity(userId, `Funds check: ${silvercoins.toLocaleString()} silvercoins`);
        return silvercoins;
    } else {
        if (result.status === 401) {
            logActivity(userId, 'JWT expired during funds check, attempting refresh...');
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) {
                return await checkFunds(userId); // Retry after refresh
            }
        }
        logActivity(userId, `Funds check failed: ${result.error}`);
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
    const userAchievementsUrl = `${BASE_URL}/v1/achievements/${user.userClaimAchivID}/user`;
    const headers = {
        'x-user-jwt': user.jwtToken
    };

    logActivity(userId, 'Starting achievements claim process...');

    try {
        // Get available achievements
        const achievementsResult = await makeAPIRequest(userAchievementsUrl, 'GET', headers);
        
        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                logActivity(userId, 'JWT expired during achievements check, attempting refresh...');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    return await claimAchievements(userId); // Retry after refresh
                }
            }
            logActivity(userId, `Achievements check failed: ${achievementsResult.error}`);
            return 0;
        }

        const validIDs = [];
        const categories = ['achievements', 'daily', 'weekly', 'monthly'];

        // Collect claimable achievement IDs
        categories.forEach(category => {
            if (achievementsResult.data.data[category]) {
                achievementsResult.data.data[category].forEach(item => {
                    if (item.progress?.claimAvailable) {
                        validIDs.push(item.id);
                    }
                });
            }
        });

        if (validIDs.length === 0) {
            logActivity(userId, 'No achievements available to claim');
            return 0;
        }

        logActivity(userId, `Found ${validIDs.length} achievements to claim`);

        // Claim achievements
        for (const achievementId of validIDs) {
            const claimUrl = `${BASE_URL}/v1/achievements/${achievementId}/claim/`;
            const claimResult = await makeAPIRequest(claimUrl, 'POST', headers);

            if (claimResult.success) {
                totalClaimed++;
                logActivity(userId, `Claimed achievement ID: ${achievementId}`);
            } else {
                logActivity(userId, `Failed to claim achievement ${achievementId}: ${claimResult.error}`);
            }

            // Small delay between claims
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        user.achievementsClaimed += totalClaimed;
        logActivity(userId, `Successfully claimed ${totalClaimed} achievements`);
        return totalClaimed;

    } catch (error) {
        logActivity(userId, `Error in achievements process: ${error.message}`);
        return 0;
    }
}

// BLOCK 3: Spinner Functionality (Simplified - Free spins only)
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for spin');
        return null;
    }

    logActivity(userId, 'Executing free spin...');

    try {
        const spinUrl = `${BASE_URL}/v1/spinner/spin?categoryId=1`;
        const headers = {
            'x-user-jwt': user.jwtToken,
            'Content-Type': 'application/json'
        };

        const spinResult = await makeAPIRequest(spinUrl, 'POST', headers, {
            spinnerId: 6799
        });

        if (!spinResult.success) {
            if (spinResult.status === 401) {
                logActivity(userId, 'JWT expired during spin, attempting refresh...');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    return await executeSpin(userId); // Retry after refresh
                }
            }
            throw new Error(`Spin failed: ${spinResult.error}`);
        }

        const spinData = spinResult.data.data;
        const resultId = spinData.id;
        
        // Prize mapping
        const prizeMap = {
            11755: "5,000 Silvercoins",
            11750: "Core Standard Pack", 
            11749: "500 Silvercoins",
            11754: "1,000,000 Silvercoins",
            11753: "100,000 Silvercoins",
            11752: "2,500 Silvercoins",
            11751: "1,000 Silvercoins"
        };

        const prizeName = prizeMap[resultId] || `ID = ${resultId}`;
        user.spinCount++;

        logActivity(userId, `Spin successful! Received: ${prizeName}`);
        return prizeName;

    } catch (error) {
        logActivity(userId, `Spin failed: ${error.message}`);
        return null;
    }
}


// Calculate next spin time with randomization
function calculateNextSpinTime(userId) {
    const user = userData[userId];
    if (!user) return null;

    const baseIntervalMs = user.baseInterval * 60 * 1000; // Convert to milliseconds
    const randomAddMs = Math.floor(
        Math.random() * (user.randomScale2 - user.randomScale1) + user.randomScale1
    ) * 1000; // Convert to milliseconds

    const totalDelayMs = baseIntervalMs + randomAddMs;
    const nextSpinTime = new Date(Date.now() + totalDelayMs);

    user.nextSpinTime = nextSpinTime.toISOString();
    
    logActivity(userId, `Next spin scheduled in ${Math.round(totalDelayMs/1000/60)} minutes (at ${nextSpinTime.toUTCString()})`);
    
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
        
        const userIndex = users.findIndex(u => u.userId === userId);
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
    const logEntry = {
        timestamp,
        userId,
        message
    };

    activityLogs.unshift(logEntry); // Add to beginning for reverse chronological order
    activityLogs = activityLogs.slice(0, 1000); // Keep only last 1000 entries

    // Also store in user-specific logs
    if (userData[userId]) {
        userData[userId].logs.unshift(logEntry);
        userData[userId].logs = userData[userId].logs.slice(0, 200); // Keep last 200 per user
    }

    console.log(`[${timestamp}] User ${userId}: ${message}`);
}

// Scheduled Tasks
function startScheduledTasks() {
    console.log('Starting scheduled tasks...');

    // Refresh tokens daily at specified start times
    cron.schedule('0 0 * * *', () => {
        Object.keys(userData).forEach(userId => {
            const user = userData[userId];
            if (isWithinActiveWindow(userId)) {
                refreshToken(userId);
            }
        });
    });

    // Check funds every hour during active windows
    cron.schedule('0 * * * *', () => {
        Object.keys(userData).forEach(userId => {
            if (isWithinActiveWindow(userId)) {
                checkFunds(userId);
            }
        });
    });

    // Claim achievements 3 times daily
    cron.schedule('0 0,5,23 * * *', () => {
        Object.keys(userData).forEach(userId => {
            if (isWithinActiveWindow(userId)) {
                claimAchievements(userId);
            }
        });
    });

    // Continuous spin execution during active windows
    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            const user = userData[userId];
            
            if (!isWithinActiveWindow(userId)) {
                continue;
            }

            // Execute spin if it's time
            if (!user.nextSpinTime || new Date() >= new Date(user.nextSpinTime)) {
                const spinResult = await executeSpin(userId);
                if (spinResult) {
                    calculateNextSpinTime(userId);
                }
            }
        }
    }, 30000); // Check every 30 seconds

    console.log('Scheduled tasks started');
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

// Manual trigger endpoints (for testing)
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

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initializeApp();
});