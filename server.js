const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: false
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});
const path = require('path');
const fs = require('fs');

// Serve static files
app.use(express.static(__dirname));

// Add CORS headers for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Health check endpoint for render.com
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game state
const gameState = {
    players: new Map(),
    playerCount: 0,
    pills: new Map()
};

// Persistent storage files
const PLAYER_SCORES_FILE = 'player_scores.json';
const DAILY_LEADERBOARD_FILE = 'daily_leaderboard.json';
const ALL_TIME_LEADERBOARD_FILE = 'all_time_leaderboard.json';

// Player scores storage (persistent across sessions)
let playerScores = new Map(); // playerId -> {name, score, lastSeen}

// Session tokens for legitimate score restoration
let sessionTokens = new Map(); // token -> {name, score, created}

// Daily leaderboard system
const dailyLeaderboard = {
    currentDay: new Date().toDateString(),
    topScores: new Map(), // playerId -> {name, score, timestamp}
    resetTime: null,
    timeRemaining: 0
};

// All-time leaderboard system (top 3 highest scores ever)
let allTimeLeaderboard = [];

// Load persistent data on startup
function loadPlayerScores() {
    try {
        if (fs.existsSync(PLAYER_SCORES_FILE)) {
            const data = fs.readFileSync(PLAYER_SCORES_FILE, 'utf8');
            const parsed = JSON.parse(data);
            playerScores = new Map(Object.entries(parsed));
            console.log(`📊 Loaded ${playerScores.size} player scores from storage`);
        }
    } catch (error) {
        console.error('❌ Error loading player scores:', error);
        playerScores = new Map();
    }
}

function savePlayerScores() {
    try {
        const data = Object.fromEntries(playerScores);
        fs.writeFileSync(PLAYER_SCORES_FILE, JSON.stringify(data, null, 2));
        console.log(`💾 Saved ${playerScores.size} player scores to storage`);
    } catch (error) {
        console.error('❌ Error saving player scores:', error);
    }
}

function loadDailyLeaderboard() {
    try {
        if (fs.existsSync(DAILY_LEADERBOARD_FILE)) {
            const data = fs.readFileSync(DAILY_LEADERBOARD_FILE, 'utf8');
            const parsed = JSON.parse(data);
            
            // Check if it's the same day
            if (parsed.currentDay === new Date().toDateString()) {
                dailyLeaderboard.currentDay = parsed.currentDay;
                dailyLeaderboard.topScores = new Map(Object.entries(parsed.topScores || {}));
                dailyLeaderboard.resetTime = parsed.resetTime;
                console.log(`📊 Loaded daily leaderboard with ${dailyLeaderboard.topScores.size} entries`);
            } else {
                console.log('🗓️ New day detected, starting fresh daily leaderboard');
            }
        }
    } catch (error) {
        console.error('❌ Error loading daily leaderboard:', error);
    }
}

function saveDailyLeaderboard() {
    try {
        const data = {
            currentDay: dailyLeaderboard.currentDay,
            topScores: Object.fromEntries(dailyLeaderboard.topScores),
            resetTime: dailyLeaderboard.resetTime
        };
        fs.writeFileSync(DAILY_LEADERBOARD_FILE, JSON.stringify(data, null, 2));
        console.log(`💾 Saved daily leaderboard with ${dailyLeaderboard.topScores.size} entries`);
    } catch (error) {
        console.error('❌ Error saving daily leaderboard:', error);
    }
}

function loadAllTimeLeaderboard() {
    try {
        if (fs.existsSync(ALL_TIME_LEADERBOARD_FILE)) {
            const data = fs.readFileSync(ALL_TIME_LEADERBOARD_FILE, 'utf8');
            allTimeLeaderboard = JSON.parse(data);
            console.log(`🏆 Loaded all-time leaderboard with ${allTimeLeaderboard.length} entries`);
        }
    } catch (error) {
        console.error('❌ Error loading all-time leaderboard:', error);
        allTimeLeaderboard = [];
    }
}

function saveAllTimeLeaderboard() {
    try {
        fs.writeFileSync(ALL_TIME_LEADERBOARD_FILE, JSON.stringify(allTimeLeaderboard, null, 2));
        console.log(`🏆 Saved all-time leaderboard with ${allTimeLeaderboard.length} entries`);
    } catch (error) {
        console.error('❌ Error saving all-time leaderboard:', error);
    }
}

function generateSessionToken() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function cleanupExpiredTokens() {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    
    for (const [token, data] of sessionTokens.entries()) {
        if (now - data.created > TWENTY_FOUR_HOURS) {
            sessionTokens.delete(token);
        }
    }
}

function updateAllTimeLeaderboard(playerName, score) {
    // Check if this score qualifies for top 3 all-time
    const newEntry = {
        name: playerName,
        score: score,
        timestamp: Date.now(),
        date: new Date().toLocaleDateString()
    };
    
    // Check if player already has a score in all-time leaderboard
    const existingIndex = allTimeLeaderboard.findIndex(entry => entry.name === playerName);
    
    if (existingIndex !== -1) {
        // Player exists, update if new score is higher
        if (score > allTimeLeaderboard[existingIndex].score) {
            allTimeLeaderboard[existingIndex] = newEntry;
            console.log(`🏆 Updated ${playerName}'s all-time best: ${score} points`);
        }
    } else {
        // New player, add to leaderboard
        allTimeLeaderboard.push(newEntry);
        console.log(`🏆 Added ${playerName} to all-time leaderboard: ${score} points`);
    }
    
    // Sort by score (highest first) and keep only top 3
    allTimeLeaderboard.sort((a, b) => b.score - a.score);
    allTimeLeaderboard = allTimeLeaderboard.slice(0, 3);
    
    // Save to file
    saveAllTimeLeaderboard();
    
    // Broadcast updated all-time leaderboard to all clients
    io.emit('allTimeLeaderboardUpdate', {
        topScores: allTimeLeaderboard
    });
}

// Initialize daily reset timer
function initializeDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0); // Reset at midnight
    
    dailyLeaderboard.resetTime = tomorrow.getTime();
    updateTimeRemaining();
    
    console.log(`🕐 Daily leaderboard will reset at: ${tomorrow.toLocaleString()}`);
}

function updateTimeRemaining() {
    const now = Date.now();
    dailyLeaderboard.timeRemaining = Math.max(0, dailyLeaderboard.resetTime - now);
}

function resetDailyLeaderboard() {
    console.log('🔄 Resetting daily leaderboard...');
    
    // Log the final leaderboard before reset
    if (dailyLeaderboard.topScores.size > 0) {
        console.log('📊 Final daily leaderboard:');
        const sortedScores = Array.from(dailyLeaderboard.topScores.values())
            .sort((a, b) => b.score - a.score);
        sortedScores.forEach((entry, index) => {
            console.log(`${index + 1}. ${entry.name}: ${entry.score} points`);
        });
    }
    
    // Reset the leaderboard
    dailyLeaderboard.topScores.clear();
    dailyLeaderboard.currentDay = new Date().toDateString();
    
    // Set next reset time
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    dailyLeaderboard.resetTime = tomorrow.getTime();
    
    // Save the reset leaderboard
    saveDailyLeaderboard();
    
    // Broadcast reset to all clients
    io.emit('dailyLeaderboardReset', {
        newDay: dailyLeaderboard.currentDay,
        timeRemaining: dailyLeaderboard.timeRemaining
    });
    
    console.log(`🆕 New daily leaderboard started for: ${dailyLeaderboard.currentDay}`);
}

function updateDailyLeaderboard(playerId, playerName, score) {
    // Use player name as the key instead of socket ID for persistence across sessions
    const playerKey = playerName;
    const currentEntry = dailyLeaderboard.topScores.get(playerKey);
    
    // Always update the player's current score (even if it's the same or lower)
    dailyLeaderboard.topScores.set(playerKey, {
        name: playerName,
        score: score,
        timestamp: Date.now()
    });
    
    // Save to persistent storage
    saveDailyLeaderboard();
    
    console.log(`📈 Daily leaderboard updated: ${playerName} - ${score} points`);
    
    // Always broadcast current standings to all players
    const sortedScores = Array.from(dailyLeaderboard.topScores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 10); // Top 10
        
    console.log(`📊 Broadcasting daily leaderboard to all players:`, sortedScores);
    io.emit('dailyLeaderboardUpdate', {
        topScores: sortedScores,
        currentDay: dailyLeaderboard.currentDay
        // Removed timeRemaining to prevent timer reset on pill collection
    });
}

// Load persistent data and initialize the daily reset system
loadPlayerScores();
loadDailyLeaderboard();
loadAllTimeLeaderboard();
initializeDailyReset();

// Update time remaining every second for real-time countdown
setInterval(() => {
    updateTimeRemaining();
    
    // Check if it's time to reset
    if (dailyLeaderboard.timeRemaining <= 0) {
        resetDailyLeaderboard();
    }
    
    // Broadcast time update every second for real-time countdown
    // Client will intelligently handle updates to prevent jumping
    io.emit('timeUpdate', {
        timeRemaining: dailyLeaderboard.timeRemaining
    });
}, 1000); // Every second for real-time updates

// Periodic save of player scores (every 30 seconds)
setInterval(() => {
    if (playerScores.size > 0) {
        savePlayerScores();
    }
}, 30000);

// Cleanup expired session tokens (every hour)
setInterval(() => {
    cleanupExpiredTokens();
}, 60 * 60 * 1000);

// Pill settings
const MAX_PILLS = 30; // Reduced from 60 for better performance
const PILL_SPAWN_INTERVAL = 500; // Increased from 200ms to reduce network traffic
const PILL_SIZE = 45; // Increased by 50%

// Game settings
const MELEE_RANGE = 100;
const MELEE_DAMAGE = 25;
const MELEE_ANGLE = Math.PI / 3;
const RESPAWN_TIME = 3000;
const MAP_WIDTH = 4800;
const MAP_HEIGHT = 3200;
const PLAYER_RADIUS = 20;

// Player colors
const PLAYER_COLORS = [
    '#00d4ff', '#7c3aed', '#ef4444', '#22c55e',
    '#f97316', '#eab308', '#ec4899', '#14b8a6'
];

let nextPlayerId = 1;

function getRandomColor() {
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function getRandomSpawnPoint() {
    const margin = 100;
    return {
        x: margin + Math.random() * (MAP_WIDTH - 2 * margin),
        y: margin + Math.random() * (MAP_HEIGHT - 2 * margin)
    };
}

function generatePill() {
    // Only spawn if we're below the max limit
    if (gameState.pills.size >= MAX_PILLS) {
        return;
    }
    
    const pillId = 'pill_' + Date.now() + '_' + Math.random();
    const spawn = getRandomSpawnPoint();
    
    const pill = {
        id: pillId,
        x: spawn.x,
        y: spawn.y,
        points: 1, // Consistent 1 point per pill
        spawnTime: Date.now() // Add spawn time for animation
    };
    
    gameState.pills.set(pillId, pill);
    
    // Send pill spawn event with animation data
    io.emit('pillSpawned', {
        ...pill,
        animated: true // Flag for client-side animation
    });
}

function checkPillCollection(playerId, playerX, playerY) {
    const player = gameState.players.get(playerId);
    if (!player) return;
    
    for (const [pillId, pill] of gameState.pills.entries()) {
        const dx = playerX - pill.x;
        const dy = playerY - pill.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance <= (PLAYER_RADIUS + PILL_SIZE / 2)) {
            // Player collected the pill
            player.score = (player.score || 0) + pill.points;
            gameState.pills.delete(pillId);
            
            // Update persistent player score
            const playerKey = `${player.name}_${playerId}`;
            playerScores.set(playerKey, {
                name: player.name,
                score: player.score,
                lastSeen: Date.now()
            });
            savePlayerScores();
            
            io.emit('pillCollected', {
                pillId: pillId,
                playerId: playerId,
                points: pill.points,
                newScore: player.score
            });
            
            console.log(`💊 ${player.name} collected pill (+${pill.points}) → Score: ${player.score}`);
            
            // Update daily leaderboard
            updateDailyLeaderboard(playerId, player.name, player.score);
            
            // Update all-time leaderboard
            updateAllTimeLeaderboard(player.name, player.score);
            break;
        }
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    // Create new player
    const spawn = getRandomSpawnPoint();
    const playerNumber = nextPlayerId++;
    
    const newPlayer = {
        id: socket.id,
        x: spawn.x,
        y: spawn.y,
        health: 100,
        maxHealth: 100,
        color: getRandomColor(),
        name: `Player ${playerNumber}`,
        angle: 0,
        direction: 1, // Add default direction (facing left)
        weaponAngle: 0, // Add default weapon angle
        kills: 0,
        score: 0, // Add score for pill collection
        lastActivity: Date.now()
    };

    console.log('Created new player:', newPlayer);

    // Add player to game state
    gameState.players.set(socket.id, newPlayer);
    gameState.playerCount = gameState.players.size;

    console.log('Current players:', Array.from(gameState.players.entries()));

    // Send initial game state
    const currentState = {
        players: Array.from(gameState.players.entries()).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {}),
        playerCount: gameState.playerCount,
        pills: Array.from(gameState.pills.entries()).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {}),
        dailyLeaderboard: {
            topScores: Array.from(dailyLeaderboard.topScores.values())
                .sort((a, b) => b.score - a.score)
                .slice(0, 10),
            timeRemaining: dailyLeaderboard.timeRemaining,
            currentDay: dailyLeaderboard.currentDay
        },
        allTimeLeaderboard: {
            topScores: allTimeLeaderboard
        }
    };
    
    console.log('Sending initial state with daily leaderboard:', {
        dailyLeaderboard: currentState.dailyLeaderboard,
        dailyTopScoresCount: currentState.dailyLeaderboard.topScores.length,
        dailyTopScoresContent: currentState.dailyLeaderboard.topScores
    });
    socket.emit('gameState', currentState);
    
    io.emit('playerUpdate', {
        id: newPlayer.id,
        x: newPlayer.x,
        y: newPlayer.y,
        health: newPlayer.health,
        maxHealth: newPlayer.maxHealth,
        color: newPlayer.color,
        name: newPlayer.name,
        direction: newPlayer.direction,
        weaponAngle: newPlayer.weaponAngle || 0
    });
    io.emit('playerCountUpdate', gameState.playerCount);

    // Handle username setting
    socket.on('setUsername', (data) => {
        const player = gameState.players.get(socket.id);
        let username, sessionToken;
        
        // Handle both old format (string) and new format (object)
        if (typeof data === 'string') {
            username = data;
            sessionToken = null;
        } else {
            username = data.username;
            sessionToken = data.sessionToken;
        }
        
        if (player && username && username.trim().length > 0) {
            // Validate and sanitize username
            const cleanUsername = username.trim().substring(0, 15);
            player.name = cleanUsername;
            
            // Only restore score from valid session token - no automatic restoration
            let restoredScore = 0; // Default to 0 for fresh start
            
            // Only restore score if they have a valid session token
            if (sessionToken && sessionTokens.has(sessionToken)) {
                const tokenData = sessionTokens.get(sessionToken);
                if (tokenData.name === cleanUsername) {
                    restoredScore = tokenData.score;
                    console.log(`Player ${cleanUsername} restored score using session token: ${restoredScore}`);
                    // Remove the token after use to prevent reuse
                    sessionTokens.delete(sessionToken);
                } else {
                    console.log(`Session token username mismatch: expected ${cleanUsername}, got ${tokenData.name}`);
                }
            } else {
                console.log(`Player ${cleanUsername} starting fresh with score 0`);
            }
            
            // Set the restored score (starts at 0 for new players/sessions)
            player.score = restoredScore;
            
            // Update current session record
            const playerKey = `${cleanUsername}_${socket.id}`;
            playerScores.set(playerKey, {
                name: cleanUsername,
                score: player.score,
                lastSeen: Date.now()
            });
            savePlayerScores();
            
            console.log(`Player ${socket.id} set username to: ${cleanUsername}`);
            
            // Broadcast updated player info
            io.emit('playerUpdate', {
                id: player.id,
                x: player.x,
                y: player.y,
                health: player.health,
                maxHealth: player.maxHealth,
                color: player.color,
                name: player.name,
                direction: player.direction,
                weaponAngle: player.weaponAngle || 0,
                score: player.score
            });
        }
    });

    // Handle movement
    socket.on('move', (data) => {
        const player = gameState.players.get(socket.id);
        if (player && player.health > 0) {
            // Throttle movement updates - only process if enough time has passed
            const now = Date.now();
            const timeSinceLastUpdate = now - (player.lastMovementUpdate || 0);
            
            if (timeSinceLastUpdate >= 16) { // Increased to ~60 updates per second for smoother movement
                // Update server-side position (for hit detection, etc.)
                player.x = data.x;
                player.y = data.y;
                if (data.direction !== undefined) {
                    player.direction = data.direction;
                }
                if (data.weaponAngle !== undefined) {
                    player.weaponAngle = data.weaponAngle;
                }
                player.lastActivity = now;
                player.lastMovementUpdate = now;
                
                // Check for pill collection
                checkPillCollection(socket.id, player.x, player.y);
                
                // IMPORTANT: Only broadcast to OTHER players, never back to sender
                // This prevents rubber banding completely
                socket.broadcast.emit('playerUpdate', {
                    id: socket.id,
                    x: player.x,
                    y: player.y,
                    direction: player.direction,
                    weaponAngle: player.weaponAngle,
                    health: player.health,
                    maxHealth: player.maxHealth,
                    color: player.color,
                    name: player.name,
                    score: player.score
                });
            }
        }
    });

    // Attack system removed - game now focuses on pill collection for scoring

    // Handle respawn
    socket.on('respawn', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            setTimeout(() => {
                if (gameState.players.has(socket.id)) {
                    const spawn = getRandomSpawnPoint();
                    player.x = spawn.x;
                    player.y = spawn.y;
                    player.health = player.maxHealth;
                    io.emit('playerRespawned', player);
                }
            }, RESPAWN_TIME);
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if (gameState.players.has(socket.id)) {
            const player = gameState.players.get(socket.id);
            
            // Save player's final score to daily leaderboard before they disconnect
            if (player && player.name && player.score > 0) {
                updateDailyLeaderboard(socket.id, player.name, player.score);
                console.log(`💾 Saved disconnecting player ${player.name}'s score: ${player.score}`);
                
                // Generate session token for score restoration
                const sessionToken = generateSessionToken();
                sessionTokens.set(sessionToken, {
                    name: player.name,
                    score: player.score,
                    created: Date.now()
                });
                
                // Send session token to client before they disconnect (if still connected)
                socket.emit('sessionToken', {
                    token: sessionToken,
                    name: player.name,
                    score: player.score
                });
                
                console.log(`🎫 Generated session token for ${player.name} (score: ${player.score})`);
            }
            
            io.emit('playerLeft', socket.id);
            gameState.players.delete(socket.id);
            gameState.playerCount = gameState.players.size;
            io.emit('playerCountUpdate', gameState.playerCount);
        }
    });
});

// Generate initial pills gradually instead of all at once for better performance
let initialPillsSpawned = 0;
const initialSpawnInterval = setInterval(() => {
    if (initialPillsSpawned < MAX_PILLS) {
        generatePill();
        initialPillsSpawned++;
    } else {
        clearInterval(initialSpawnInterval);
        console.log(`💊 Initial ${MAX_PILLS} pills spawned gradually`);
    }
}, 100); // Spawn one pill every 100ms

// Regular pill spawning timer for ongoing gameplay
setInterval(() => {
    generatePill();
}, PILL_SPAWN_INTERVAL);

// Graceful shutdown handler
function gracefulShutdown() {
    console.log('🔄 Shutting down gracefully...');
    savePlayerScores();
    saveDailyLeaderboard();
    saveAllTimeLeaderboard();
    console.log('💾 All data saved successfully');
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

http.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 Socket.IO transports: websocket, polling`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🎮 Local game available at: http://localhost:${PORT}`);
    }
}); 