// Poker Game Frontend - Oval Table Design
const API_BASE = '';

// CSRF Protection Utilities
const CSRFManager = {
    TOKEN_COOKIE: 'csrf_token',
    HEADER_NAME: 'X-CSRF-Token',
    TOKEN_TIMEOUT_MS: 3000,
    REQUEST_TIMEOUT_MS: 12000,

    // Get CSRF token from cookie
    getToken() {
        const match = document.cookie.match(new RegExp(`${this.TOKEN_COOKIE}=([^;]+)`));
        return match ? decodeURIComponent(match[1]) : null;
    },

    // Get headers for state-changing requests (POST/PUT/PATCH/DELETE)
    getHeaders(contentType = 'application/json') {
        const headers = {
            'Content-Type': contentType
        };
        const token = this.getToken();
        if (token) {
            headers[this.HEADER_NAME] = token;
        }
        return headers;
    },

    async ensureToken() {
        if (this.getToken()) return;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.TOKEN_TIMEOUT_MS);

        try {
            await fetch(`${API_BASE}/api/poker/csrf-token`, {
                method: 'GET',
                credentials: 'same-origin',
                signal: controller.signal
            });
        } catch (error) {
            console.log('[CSRF] Token bootstrap failed:', error.message);
        } finally {
            clearTimeout(timeoutId);
        }
    },

    // Fetch wrapper that automatically adds CSRF token for state-changing methods
    async fetch(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const stateChangingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

        if (stateChangingMethods.includes(method)) {
            await this.ensureToken();
            options.headers = {
                ...this.getHeaders(),
                ...(options.headers || {})
            };
        }

        try {
            return await fetch(url, {
                ...options,
                signal: options.signal || controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }
    }
};

// Avatar Manager - Generates and manages player avatars
const AvatarManager = {
    // Emoji avatar sets for AI opponents
    avatarSets: [
        ['🤖', '👾', '🤡', '👽', '👻', '💀', '🎃'],
        ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻'],
        ['🦁', '🐯', '🐨', '🐼', '🐷', '🐸', '🐙'],
        ['🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝'],
        ['🐛', '🦋', '🐞', '🦂', '🦀', '🦐', '🦑'],
        ['🔥', '⚡', '💎', '🌟', '🍀', '🌙', '☀️'],
        ['🎸', '🎺', '🎻', '🎮', '🎯', '🎲', '🎳'],
        ['🚀', '🛸', '🚁', '🛶', '⛵', '🚂', '🚲'],
        ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓'],
        ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉']
    ],

    // Background colors for avatars
    bgColors: [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'
    ],

    // Generate avatar for AI bot based on name
    getBotAvatar(name) {
        // Use name to deterministically select avatar
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const setIndex = Math.abs(hash) % this.avatarSets.length;
        const avatarIndex = Math.abs(hash >> 4) % this.avatarSets[setIndex].length;
        const colorIndex = Math.abs(hash >> 8) % this.bgColors.length;

        return {
            emoji: this.avatarSets[setIndex][avatarIndex],
            bgColor: this.bgColors[colorIndex],
            type: 'emoji'
        };
    },

    // Get avatar for human player
    getPlayerAvatar(name) {
        const initials = name
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);

        // Generate consistent color based on name
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const colorIndex = Math.abs(hash) % this.bgColors.length;

        return {
            initials,
            bgColor: this.bgColors[colorIndex],
            type: 'initials'
        };
    },

    // Render avatar HTML
    render(avatar, size = 'medium') {
        const sizeClass = size === 'small' ? 'avatar-small' : size === 'large' ? 'avatar-large' : 'avatar-medium';

        if (avatar.type === 'emoji') {
            return `<div class="avatar ${sizeClass}" style="background-color: ${escapeHtml(avatar.bgColor)};">${escapeHtml(avatar.emoji)}</div>`;
        } else {
            return `<div class="avatar ${sizeClass}" style="background-color: ${escapeHtml(avatar.bgColor)};"><span class="avatar-initials">${escapeHtml(avatar.initials)}</span></div>`;
        }
    }
};

// Touch Gesture Manager - Handles mobile swipe/tap gestures
const GestureManager = {
    touchStartX: 0,
    touchStartY: 0,
    touchStartTime: 0,
    lastTapTime: 0,
    minSwipeDistance: 50,
    maxSwipeTime: 300,
    doubleTapDelay: 300,
    isEnabled: true,

    init() {
        const gameScreen = document.getElementById('game-screen');
        if (!gameScreen) return;

        // Touch events for gestures
        gameScreen.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: true });
        gameScreen.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: true });

        // Mouse events for desktop testing
        gameScreen.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        gameScreen.addEventListener('mouseup', (e) => this.handleMouseUp(e));

        console.log('[Gestures] Gesture manager initialized');
    },

    handleTouchStart(e) {
        if (!this.isEnabled) return;
        this.touchStartX = e.changedTouches[0].screenX;
        this.touchStartY = e.changedTouches[0].screenY;
        this.touchStartTime = Date.now();
    },

    handleTouchEnd(e) {
        if (!this.isEnabled) return;

        const touchEndX = e.changedTouches[0].screenX;
        const touchEndY = e.changedTouches[0].screenY;
        const touchEndTime = Date.now();

        const deltaX = touchEndX - this.touchStartX;
        const deltaY = touchEndY - this.touchStartY;
        const deltaTime = touchEndTime - this.touchStartTime;

        // Check for double tap
        const timeSinceLastTap = touchEndTime - this.lastTapTime;
        if (timeSinceLastTap < this.doubleTapDelay && Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
            this.lastTapTime = 0;
            this.handleDoubleTap();
            return;
        }
        this.lastTapTime = touchEndTime;

        // Check for swipe
        if (deltaTime < this.maxSwipeTime) {
            // Horizontal swipe
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > this.minSwipeDistance) {
                if (deltaX > 0) {
                    this.handleSwipeRight();
                } else {
                    this.handleSwipeLeft();
                }
            }
        }
    },

    handleMouseDown(e) {
        if (!this.isEnabled) return;
        this.touchStartX = e.screenX;
        this.touchStartY = e.screenY;
        this.touchStartTime = Date.now();
    },

    handleMouseUp(e) {
        if (!this.isEnabled) return;

        const deltaX = e.screenX - this.touchStartX;
        const deltaY = e.screenY - this.touchStartY;
        const deltaTime = Date.now() - this.touchStartTime;

        // Check for swipe
        if (deltaTime < this.maxSwipeTime) {
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > this.minSwipeDistance) {
                if (deltaX > 0) {
                    this.handleSwipeRight();
                } else {
                    this.handleSwipeLeft();
                }
            }
        }
    },

    handleSwipeLeft() {
        // Swipe left to fold
        if (isMyTurn && gameState?.phase !== 'showdown') {
            this.showGestureFeedback('👋 Fold', 'left');
            playerAction('fold');
        }
    },

    handleSwipeRight() {
        // Swipe right to check (if possible) or show feedback
        if (isMyTurn && gameState?.phase !== 'showdown') {
            const myPlayer = gameState.players.find(p => p.id === playerId);
            const toCall = (gameState.current_bet || 0) - (myPlayer?.bet || 0);

            if (toCall === 0) {
                this.showGestureFeedback('✓ Check', 'right');
                playerAction('check');
            } else {
                this.showGestureFeedback('→ Swipe right to check (not available)', 'right', true);
            }
        }
    },

    handleDoubleTap() {
        // Double tap to call
        if (isMyTurn && gameState?.phase !== 'showdown') {
            const myPlayer = gameState.players.find(p => p.id === playerId);
            const toCall = (gameState.current_bet || 0) - (myPlayer?.bet || 0);

            if (toCall > 0) {
                this.showGestureFeedback('📞 Call', 'center');
                playerAction('call');
            } else {
                this.showGestureFeedback('✓ Check', 'center');
                playerAction('check');
            }
        }
    },

    showGestureFeedback(text, direction, isWarning = false) {
        const feedback = document.createElement('div');
        feedback.className = `gesture-feedback ${direction} ${isWarning ? 'warning' : ''}`;
        feedback.textContent = text;
        document.body.appendChild(feedback);

        // Trigger animation
        requestAnimationFrame(() => {
            feedback.classList.add('show');
        });

        // Remove after animation
        setTimeout(() => {
            feedback.classList.remove('show');
            setTimeout(() => feedback.remove(), 300);
        }, 1000);
    },

    enable() {
        this.isEnabled = true;
    },

    disable() {
        this.isEnabled = false;
    }
};

// Player Statistics Manager
const StatsManager = {
    stats: {
        handsPlayed: 0,
        handsWon: 0,
        biggestPotWon: 0,
        totalProfit: 0,
        totalLoss: 0,
        bestHand: null,
        sessionStart: null
    },

    init() {
        // Load saved stats from localStorage
        const saved = localStorage.getItem('poker-stats');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                this.stats = { ...this.stats, ...parsed };
            } catch (e) {
                console.log('[Stats] Failed to load saved stats');
            }
        }
        this.stats.sessionStart = new Date().toISOString();
    },

    save() {
        localStorage.setItem('poker-stats', JSON.stringify(this.stats));
    },

    recordHandPlayed() {
        this.stats.handsPlayed++;
        this.save();
    },

    recordHandWin(amount, handName) {
        this.stats.handsWon++;
        this.stats.totalProfit += amount;
        if (amount > this.stats.biggestPotWon) {
            this.stats.biggestPotWon = amount;
        }
        // Track best hand (simple hierarchy)
        const handRankings = [
            'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
            'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush'
        ];
        if (handName) {
            for (let i = handRankings.length - 1; i >= 0; i--) {
                if (handName.includes(handRankings[i]) || 
                    (handRankings[i] === 'Pair' && handName.includes('Pair')) ||
                    (handRankings[i] === 'High Card' && handName.includes('High'))) {
                    if (!this.stats.bestHand || i > handRankings.indexOf(this.stats.bestHand)) {
                        this.stats.bestHand = handRankings[i];
                    }
                    break;
                }
            }
        }
        this.save();
    },

    recordHandLoss(amount) {
        this.stats.totalLoss += amount;
        this.save();
    },

    getWinRate() {
        if (this.stats.handsPlayed === 0) return 0;
        return ((this.stats.handsWon / this.stats.handsPlayed) * 100).toFixed(1);
    },

    getNetProfit() {
        return this.stats.totalProfit - this.stats.totalLoss;
    },

    reset() {
        this.stats = {
            handsPlayed: 0,
            handsWon: 0,
            biggestPotWon: 0,
            totalProfit: 0,
            totalLoss: 0,
            bestHand: null,
            sessionStart: new Date().toISOString()
        };
        this.save();
    },

    getFormattedStats() {
        return {
            handsPlayed: this.stats.handsPlayed,
            handsWon: this.stats.handsWon,
            winRate: this.getWinRate(),
            biggestPotWon: this.stats.biggestPotWon,
            netProfit: this.getNetProfit(),
            bestHand: this.stats.bestHand || 'None yet'
        };
    }
};

// Sound Manager - Web Audio API for game sounds
const SoundManager = {
    audioContext: null,
    enabled: true,

    init() {
        // Initialize on first user interaction to comply with browser autoplay policies
        const initAudio = () => {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        };
        document.addEventListener('click', initAudio, { once: true });
        document.addEventListener('touchstart', initAudio, { once: true });
    },

    // Play card deal sound - quick noise burst with filter
    playCardDeal() {
        if (!this.enabled || !this.audioContext) return;
        try {
            const osc = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            const filter = this.audioContext.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, this.audioContext.currentTime);
            osc.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.05);

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(2000, this.audioContext.currentTime);

            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.05);

            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            osc.start(this.audioContext.currentTime);
            osc.stop(this.audioContext.currentTime + 0.05);
        } catch (e) {
            console.log('[Sound] Card deal sound failed:', e.message);
        }
    },

    // Play chip sound - short high tick
    playChip() {
        if (!this.enabled || !this.audioContext) return;
        try {
            const osc = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(1200, this.audioContext.currentTime);
            osc.frequency.exponentialRampToValueAtTime(600, this.audioContext.currentTime + 0.08);

            gainNode.gain.setValueAtTime(0.08, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);

            osc.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            osc.start(this.audioContext.currentTime);
            osc.stop(this.audioContext.currentTime + 0.08);
        } catch (e) {
            console.log('[Sound] Chip sound failed:', e.message);
        }
    },

    // Play win sound - ascending arpeggio
    playWin() {
        if (!this.enabled || !this.audioContext) return;
        try {
            const notes = [523.25, 659.25, 783.99, 1046.50]; // C major arpeggio
            notes.forEach((freq, i) => {
                const osc = this.audioContext.createOscillator();
                const gainNode = this.audioContext.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, this.audioContext.currentTime + i * 0.08);

                gainNode.gain.setValueAtTime(0, this.audioContext.currentTime + i * 0.08);
                gainNode.gain.linearRampToValueAtTime(0.15, this.audioContext.currentTime + i * 0.08 + 0.02);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + i * 0.08 + 0.25);

                osc.connect(gainNode);
                gainNode.connect(this.audioContext.destination);

                osc.start(this.audioContext.currentTime + i * 0.08);
                osc.stop(this.audioContext.currentTime + i * 0.08 + 0.25);
            });
        } catch (e) {
            console.log('[Sound] Win sound failed:', e.message);
        }
    },

    // Play loss sound - descending tone
    playLoss() {
        if (!this.enabled || !this.audioContext) return;
        try {
            const osc = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(300, this.audioContext.currentTime);
            osc.frequency.exponentialRampToValueAtTime(150, this.audioContext.currentTime + 0.3);

            gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);

            osc.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            osc.start(this.audioContext.currentTime);
            osc.stop(this.audioContext.currentTime + 0.3);
        } catch (e) {
            console.log('[Sound] Loss sound failed:', e.message);
        }
    },

    toggle() {
        this.enabled = !this.enabled;
        return this.enabled;
    }
};

// Error Boundary - Global error handling
const ErrorBoundary = {
    container: null,

    init() {
        // Create error container
        this.container = document.createElement('div');
        this.container.id = 'error-boundary';
        this.container.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            max-width: 90%;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;
        `;
        document.body.appendChild(this.container);

        // Global error handler
        window.addEventListener('error', (e) => {
            console.error('Global error:', e.error);
            this.show('An unexpected error occurred. Please refresh the page if the game is not working.', 'error');
        });

        // Unhandled promise rejection handler
        window.addEventListener('unhandledrejection', (e) => {
            console.error('Unhandled promise rejection:', e.reason);
            this.show('Network or server error. Please check your connection and try again.', 'error');
        });
    },

    show(message, type = 'error') {
        const toast = document.createElement('div');
        const colors = {
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#3b82f6'
        };

        toast.style.cssText = `
            background: ${colors[type] || colors.error};
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            animation: slideInDown 0.3s ease-out;
            pointer-events: auto;
            max-width: 400px;
            text-align: center;
        `;
        toast.textContent = message;

        // Add close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
            margin-left: 12px;
            padding: 0 4px;
            float: right;
        `;
        closeBtn.onclick = () => toast.remove();
        toast.appendChild(closeBtn);

        this.container.appendChild(toast);

        // Auto-remove after 8 seconds
        setTimeout(() => {
            toast.style.animation = 'fadeOutUp 0.3s ease-out';
            setTimeout(() => toast.remove(), 300);
        }, 8000);
    },

    // Wrap async functions with error handling
    async wrap(asyncFn, errorMessage = 'Something went wrong') {
        try {
            return await asyncFn();
        } catch (error) {
            console.error(errorMessage, error);
            this.show(`${errorMessage}: ${error.message || 'Unknown error'}`, 'error');
            throw error;
        }
    }
};

// Add animation styles for error boundary
const errorStyles = document.createElement('style');
errorStyles.textContent = `
    @keyframes slideInDown {
        from { opacity: 0; transform: translateY(-20px); }
        to { opacity: 1; transform: translateY(0); }
    }
    @keyframes fadeOutUp {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-20px); }
    }
`;
document.head.appendChild(errorStyles);

let gameState = null;
let playerId = null;
let playerToken = null;
let gameId = null;
let isMyTurn = false;
let raiseAmount = 0;
let pollIntervalId = null;
let pollInFlight = false;
let isRequestPending = false; // Lock to prevent race conditions
let actionToken = null; // Anti-replay token for security
const AI_POLL_INTERVAL_MS = 1800;
const CLOCKWISE_OPPONENT_SEATS = {
    1: ['seat-1'],
    2: ['seat-2', 'seat-3'],
    3: ['seat-2', 'seat-1', 'seat-3'],
    4: ['seat-4', 'seat-2', 'seat-3', 'seat-5'],
    5: ['seat-4', 'seat-2', 'seat-1', 'seat-3', 'seat-5']
};

// Helper function to update game state and extract action token
function updateGameState(newState) {
    gameState = newState;
    // Extract and store action token if present (for security)
    if (newState.action_token) {
        actionToken = newState.action_token;
        delete gameState.action_token; // Remove from state to avoid confusion
    }
}
let turnStartTime = null;
let turnTimerId = null;
const TURN_TIME_LIMIT = 30000; // 30 seconds per turn
let hasVibratedThisTurn = false; // Track if we've vibrated for current turn
let seenCards = new Set(); // Track cards we've already animated
let lastHandNumber = 0; // Track hand number for stats
let handResultRecorded = false; // Prevent duplicate stat recording

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function gameRequestUrl(path, params = {}) {
    const query = new URLSearchParams({
        ...params,
        player_id: playerId,
        player_token: playerToken
    });
    return `${API_BASE}/api/poker${path}?${query.toString()}`;
}

// DOM Elements
const screens = {
    start: document.getElementById('start-screen'),
    game: document.getElementById('game-screen'),
    join: document.getElementById('join-screen'),
    lobby: document.getElementById('lobby-screen')
};

const elements = {
    playerName: document.getElementById('player-name'),
    startBtn: document.getElementById('start-btn'),
    handNumber: document.getElementById('hand-number'),
    phase: document.getElementById('phase'),
    potAmount: document.getElementById('pot-amount'),
    opponentsRow: document.getElementById('opponents-row'),
    communityCards: document.getElementById('community-cards'),
    yourCards: document.getElementById('your-cards'),
    handStrength: document.getElementById('hand-strength'),
    aiActionIndicator: document.getElementById('ai-action-indicator'),
    yourName: document.getElementById('your-name'),
    yourChips: document.getElementById('your-chips'),
    actionButtons: document.getElementById('action-buttons'),
    btnFold: document.getElementById('btn-fold'),
    btnCall: document.getElementById('btn-call'),
    btnRaise: document.getElementById('btn-raise'),
    raiseContainer: document.getElementById('raise-container'),
    raiseSlider: document.getElementById('raise-slider'),
    raiseDisplay: document.getElementById('raise-display'),
    sliderMin: document.getElementById('slider-min'),
    sliderMax: document.getElementById('slider-max'),
    btnMin: document.getElementById('btn-min'),
    btnPot: document.getElementById('btn-pot'),
    btnAllIn: document.getElementById('btn-allin'),
    btnCancel: document.getElementById('btn-cancel'),
    btnConfirmRaise: document.getElementById('btn-confirm-raise'),
    showdownPanel: document.getElementById('showdown-panel'),
    showdownTitle: document.getElementById('showdown-title'),
    showdownDetails: document.getElementById('showdown-details'),
    btnNextHand: document.getElementById('btn-next-hand'),
    decisionTimer: document.getElementById('decision-timer'),
    timerText: document.getElementById('timer-text'),
    timerFill: document.getElementById('timer-fill'),
    loadingOverlay: document.getElementById('loading-overlay'),
    gameScreen: document.getElementById('game-screen'),
    statsBtn: document.getElementById('stats-btn'),
    statsModal: document.getElementById('stats-modal'),
    statsContent: document.getElementById('stats-content'),
    btnCloseStats: document.getElementById('btn-close-stats'),
    btnResetStats: document.getElementById('btn-reset-stats'),
    buyBackOverlay: document.getElementById('buy-back-overlay'),
    buyBackDetails: document.getElementById('buy-back-details'),
    finalChipCount: document.getElementById('final-chip-count'),
    btnBuyBack: document.getElementById('btn-buy-back'),
    btnEndGame: document.getElementById('btn-end-game')
};

// Theme Manager
const ThemeManager = {
    themes: ['theme-green', 'theme-blue', 'theme-red', 'theme-black', 'theme-purple'],
    currentThemeIndex: 0,

    init() {
        // Load saved theme from localStorage
        const savedTheme = localStorage.getItem('poker-theme');
        if (savedTheme && this.themes.includes(savedTheme)) {
            this.currentThemeIndex = this.themes.indexOf(savedTheme);
            this.applyTheme(savedTheme);
        }
    },

    applyTheme(themeClass) {
        if (!elements.gameScreen) return;
        
        // Remove all theme classes
        this.themes.forEach(t => elements.gameScreen.classList.remove(t));
        
        // Add new theme class
        elements.gameScreen.classList.add(themeClass);
        
        // Save to localStorage
        localStorage.setItem('poker-theme', themeClass);
    },

    nextTheme() {
        this.currentThemeIndex = (this.currentThemeIndex + 1) % this.themes.length;
        const nextTheme = this.themes[this.currentThemeIndex];
        this.applyTheme(nextTheme);
        
        // Provide haptic feedback if available
        if (navigator.vibrate) {
            navigator.vibrate(20);
        }
    }
};

// Dark Mode Manager
const DarkModeManager = {
    isDarkMode: true,

    init() {
        // Load saved preference from localStorage
        const savedMode = localStorage.getItem('poker-dark-mode');
        if (savedMode !== null) {
            this.isDarkMode = savedMode === 'true';
        }
        this.applyMode();
    },

    applyMode() {
        const body = document.body;
        const modeIcon = document.getElementById('mode-icon');
        
        if (this.isDarkMode) {
            body.classList.remove('light-mode');
            if (modeIcon) modeIcon.textContent = '🌙';
        } else {
            body.classList.add('light-mode');
            if (modeIcon) modeIcon.textContent = '☀️';
        }
        
        // Save to localStorage
        localStorage.setItem('poker-dark-mode', this.isDarkMode);
    },

    toggle() {
        this.isDarkMode = !this.isDarkMode;
        this.applyMode();
        
        // Provide haptic feedback if available
        if (navigator.vibrate) {
            navigator.vibrate(20);
        }
    }
};

// Card Deck Theme Manager
const CardDeckManager = {
    decks: ['card-deck-classic', 'card-deck-modern', 'card-deck-minimal', 'card-deck-vintage', 'card-deck-neon'],
    deckLabels: ['Classic', 'Modern', 'Minimal', 'Vintage', 'Neon'],
    currentDeckIndex: 0,

    init() {
        // Load saved deck theme from localStorage
        const savedDeck = localStorage.getItem('poker-card-deck');
        if (savedDeck && this.decks.includes(savedDeck)) {
            this.currentDeckIndex = this.decks.indexOf(savedDeck);
            this.applyDeck(savedDeck);
        }
    },

    applyDeck(deckClass) {
        if (!elements.gameScreen) return;
        
        // Remove all deck classes
        this.decks.forEach(d => elements.gameScreen.classList.remove(d));
        
        // Add new deck class
        elements.gameScreen.classList.add(deckClass);
        
        // Update label
        const deckLabel = document.getElementById('deck-label');
        if (deckLabel) {
            deckLabel.textContent = this.deckLabels[this.currentDeckIndex];
        }
        
        // Save to localStorage
        localStorage.setItem('poker-card-deck', deckClass);
    },

    nextDeck() {
        this.currentDeckIndex = (this.currentDeckIndex + 1) % this.decks.length;
        const nextDeck = this.decks[this.currentDeckIndex];
        this.applyDeck(nextDeck);
        
        // Provide haptic feedback if available
        if (navigator.vibrate) {
            navigator.vibrate(20);
        }
    }
};

// Chip Stack Visualizer
const ChipStackVisualizer = {
    // Chip denominations and their colors
    denominations: [
        { value: 1000, color: 'chip-purple', max: 10 },
        { value: 500, color: 'chip-black', max: 8 },
        { value: 100, color: 'chip-gold', max: 8 },
        { value: 25, color: 'chip-green', max: 10 },
        { value: 5, color: 'chip-red', max: 10 },
        { value: 1, color: 'chip-blue', max: 10 }
    ],

    /**
     * Generate HTML for chip stack visualization
     * @param {number} amount - Chip amount to display
     * @param {boolean} showAmount - Whether to show the numeric amount alongside
     * @param {boolean} large - Whether to use large chip size
     * @returns {string} HTML string for chip stack
     */
    render(amount, showAmount = true, large = false) {
        if (amount <= 0) return '<span class="chips-amount">0</span>';
        
        let remaining = amount;
        const chips = [];
        
        // Calculate chips for each denomination
        for (const denom of this.denominations) {
            const count = Math.min(Math.floor(remaining / denom.value), denom.max);
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    chips.push(denom.color);
                }
                remaining -= count * denom.value;
            }
        }
        
        // Cap total visible chips for performance and aesthetics
        const maxVisibleChips = large ? 25 : 15;
        const displayChips = chips.slice(0, maxVisibleChips);
        
        const stackClass = large ? 'chip-stack-large' : 'chip-stack';
        const chipsHTML = displayChips.map(color => `<div class="chip ${color}"></div>`).join('');
        
        if (showAmount) {
            return `
                <span class="chips-display">
                    <span class="${stackClass}">${chipsHTML}</span>
                    <span class="chips-amount">${amount}</span>
                </span>
            `;
        } else {
            return `<span class="${stackClass}">${chipsHTML}</span>`;
        }
    },

    /**
     * Render a simplified chip indicator (just a few chips + amount)
     * Used for opponent chip displays
     */
    renderCompact(amount) {
        if (amount <= 0) return '0';
        
        // Determine the highest denomination
        let color = 'chip-blue';
        if (amount >= 500) color = 'chip-purple';
        else if (amount >= 100) color = 'chip-black';
        else if (amount >= 25) color = 'chip-gold';
        else if (amount >= 5) color = 'chip-green';
        
        // Show 1-3 chips based on amount size
        let chipCount = 1;
        if (amount >= 100) chipCount = 2;
        if (amount >= 500) chipCount = 3;
        
        const chipsHTML = Array(chipCount).fill(`<div class="chip ${color}"></div>`).join('');
        
        return `
            <span class="chips-display">
                <span class="chip-stack">${chipsHTML}</span>
                <span class="chips-amount">${amount}</span>
            </span>
        `;
    }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Initialize error boundary, sound manager, theme manager, dark mode, stats, and chat
    ErrorBoundary.init();
    SoundManager.init();
    ThemeManager.init();
    DarkModeManager.init();
    CardDeckManager.init();
    StatsManager.init();

    // Cleanup on page unload
    window.addEventListener('beforeunload', stopPolling);
    window.addEventListener('pagehide', stopPolling);
    
    // Pause polling when tab is hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopPolling();
        } else if (gameState && gameState.phase !== 'showdown') {
            startPolling();
        }
    });
    
    elements.startBtn.addEventListener('click', () => startGame('single'));
    
    // Multiplayer buttons
    const createMultiplayerBtn = document.getElementById('create-multiplayer-btn');
    const joinMultiplayerBtn = document.getElementById('join-multiplayer-btn');
    const joinBtn = document.getElementById('join-btn');
    const backToStartBtn = document.getElementById('back-to-start');
    const startMultiplayerBtn = document.getElementById('start-multiplayer-btn');
    const leaveLobbyBtn = document.getElementById('leave-lobby-btn');
    
    if (createMultiplayerBtn) {
        createMultiplayerBtn.addEventListener('click', () => createMultiplayerGame());
    }
    if (joinMultiplayerBtn) {
        joinMultiplayerBtn.addEventListener('click', () => switchScreen('join'));
    }
    if (joinBtn) {
        joinBtn.addEventListener('click', () => joinMultiplayerGame());
    }
    if (backToStartBtn) {
        backToStartBtn.addEventListener('click', () => switchScreen('start'));
    }
    if (startMultiplayerBtn) {
        startMultiplayerBtn.addEventListener('click', () => startMultiplayerGame());
    }
    if (leaveLobbyBtn) {
        leaveLobbyBtn.addEventListener('click', () => {
            stopPolling();
            gameId = null;
            playerId = null;
            playerToken = null;
            gameState = null;
            switchScreen('start');
        });
    }
    
    elements.btnFold.addEventListener('click', () => playerAction('fold'));
    elements.btnCall.addEventListener('click', () => playerAction('call'));
    elements.btnRaise.addEventListener('click', showRaiseControls);
    elements.btnCancel.addEventListener('click', hideRaiseControls);
    elements.btnConfirmRaise.addEventListener('click', confirmRaise);
    elements.btnNextHand.addEventListener('click', handleShowdownPrimaryAction);
    
    elements.raiseSlider.addEventListener('input', (e) => {
        raiseAmount = parseInt(e.target.value);
        elements.raiseDisplay.textContent = raiseAmount;
    });
    
    elements.btnMin.addEventListener('click', () => {
        const min = gameState?.min_raise || 20;
        const toCall = gameState?.current_bet || 0;
        const myPlayer = gameState?.players?.find(p => p.id === playerId);
        const myBet = myPlayer?.bet || 0;
        setRaiseAmount(toCall - myBet + min);
    });
    
    elements.btnPot.addEventListener('click', () => {
        const pot = gameState?.pot || 0;
        setRaiseAmount(pot);
    });
    
    elements.btnAllIn.addEventListener('click', () => {
        const myPlayer = gameState?.players?.find(p => p.id === playerId);
        if (myPlayer) {
            setRaiseAmount(myPlayer.chips);
        }
    });

    // Stats button listeners
    if (elements.statsBtn) {
        elements.statsBtn.addEventListener('click', showStats);
    }
    if (elements.btnCloseStats) {
        elements.btnCloseStats.addEventListener('click', hideStats);
    }
    if (elements.btnResetStats) {
        elements.btnResetStats.addEventListener('click', () => {
            if (confirm('Reset all statistics? This cannot be undone.')) {
                StatsManager.reset();
                showStats();
            }
        });
    }

    // Buy-back button listeners
    if (elements.btnBuyBack) {
        elements.btnBuyBack.addEventListener('click', buyBackIn);
    }
    if (elements.btnEndGame) {
        elements.btnEndGame.addEventListener('click', endGame);
    }
});

function setRaiseAmount(amount) {
    const myPlayer = gameState?.players?.find(p => p.id === playerId);
    if (!myPlayer) return;

    amount = Math.min(amount, myPlayer.chips);
    amount = Math.max(amount, 0);

    elements.raiseSlider.value = amount;
    raiseAmount = amount;
    elements.raiseDisplay.textContent = amount;
}

function showLoading(text = 'Loading...') {
    if (elements.loadingOverlay) {
        elements.loadingOverlay.querySelector('.loading-text').textContent = text;
        elements.loadingOverlay.classList.remove('hidden');
    }
}

function hideLoading() {
    if (elements.loadingOverlay) {
        elements.loadingOverlay.classList.add('hidden');
    }
}

async function getErrorMessage(response, fallback) {
    const contentType = response.headers.get('content-type') || '';
    let payload = null;

    if (contentType.includes('application/json')) {
        payload = await response.json().catch(() => null);
    } else {
        payload = await response.text().catch(() => null);
    }

    const detail = typeof payload === 'string'
        ? payload
        : payload?.detail || payload?.message || payload?.error;

    if (response.status === 404 && /Application not found/i.test(detail || '')) {
        return 'Poker API is unavailable. The production API backend is not responding.';
    }

    return detail || fallback;
}

async function startGame(gameType = 'single') {
    const name = elements.playerName.value.trim() || 'Palmer';

    // Clear seen cards and reset deal sequence for new game
    seenCards.clear();
    resetCardDealSequence();

    try {
        elements.startBtn.disabled = true;
        showLoading('Starting game...');

        const response = await CSRFManager.fetch(`${API_BASE}/api/poker/games`, {
            method: 'POST',
            body: JSON.stringify({ 
                player_name: name,
                game_type: gameType
            })
        });

        if (!response.ok) {
            throw new Error(await getErrorMessage(response, 'Failed to start game'));
        }

        const data = await response.json();
        gameId = data.game_id;
        playerId = data.player_id;
        playerToken = data.player_token;
        updateGameState(data.state);

        elements.yourName.textContent = name;

        hideLoading();
        
        if (gameType === 'multiplayer' && data.waiting) {
            // Show lobby for multiplayer
            showLobby(data);
        } else {
            switchScreen('game');
            updateGameDisplay();
            startPolling();
        }

    } catch (error) {
        console.error('Error starting game:', error);
        hideLoading();
        const message = error.name === 'AbortError'
            ? 'Poker API timed out. Please try again in a moment.'
            : error.message || 'Failed to start game. Please try again.';
        ErrorBoundary.show(message, 'error');
        elements.startBtn.disabled = false;
    }
}

// Multiplayer functions
async function createMultiplayerGame() {
    await startGame('multiplayer');
}

function showLobby(data) {
    switchScreen('lobby');
    document.getElementById('lobby-game-id').textContent = `Game ID: ${data.game_id}`;
    updateLobbyPlayers(data.players);
    
    // Show start button only for host (first player)
    const isHost = data.players[0]?.id === playerId;
    const startBtn = document.getElementById('start-multiplayer-btn');
    if (isHost && startBtn) {
        startBtn.classList.remove('hidden');
    }
    
    // Poll for lobby updates
    startLobbyPolling();
}

function updateLobbyPlayers(players) {
    const container = document.getElementById('lobby-players');
    if (!container) return;

    container.replaceChildren(...players.map((p, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding: 8px; background: rgba(255,255,255,0.1); border-radius: 8px; margin-bottom: 8px;';
        row.textContent = `${i === 0 ? 'Host ' : ''}${p.name} ${p.id === playerId ? '(You)' : ''}`;
        return row;
    }));
    
    const statusEl = document.getElementById('lobby-status');
    if (statusEl) {
        if (players.length < 2) {
            statusEl.textContent = 'Waiting for more players...';
        } else {
            statusEl.textContent = `${players.length} players ready!`;
        }
    }
}

let lobbyPollInterval = null;

function startLobbyPolling() {
    if (lobbyPollInterval) clearInterval(lobbyPollInterval);
    
    lobbyPollInterval = setInterval(async () => {
        if (!gameId) {
            clearInterval(lobbyPollInterval);
            return;
        }
        
        try {
            const response = await fetch(gameRequestUrl(`/games/${gameId}`, { process_ai: 'false' }));
            if (response.ok) {
                const data = await response.json();
                updateLobbyPlayers(data.players);
                
                // Check if game has started
                if (data.phase !== 'waiting') {
                    clearInterval(lobbyPollInterval);
                    updateGameState(data);
                    switchScreen('game');
                    updateGameDisplay();
                    startPolling();
                }
            }
        } catch (e) {
            console.error('Lobby poll error:', e);
        }
    }, 2000);
}

async function joinMultiplayerGame() {
    const gameIdInput = document.getElementById('join-game-id');
    const name = elements.playerName.value.trim() || 'Palmer';
    const joinGameId = gameIdInput?.value?.trim();
    
    if (!joinGameId) {
        ErrorBoundary.show('Please enter a Game ID', 'error');
        return;
    }
    
    try {
        const response = await CSRFManager.fetch(`${API_BASE}/api/poker/games/join`, {
            method: 'POST',
            body: JSON.stringify({ 
                game_id: joinGameId,
                player_name: name
            })
        });
        
        if (!response.ok) {
            throw new Error(await getErrorMessage(response, 'Failed to join game'));
        }
        
        const data = await response.json();
        gameId = data.game_id;
        playerId = data.player_id;
        playerToken = data.player_token;
        
        elements.yourName.textContent = name;
        
        if (data.waiting) {
            showLobby(data);
        } else {
            updateGameState(data.state);
            switchScreen('game');
            updateGameDisplay();
            startPolling();
        }
        
    } catch (error) {
        console.error('Error joining game:', error);
        ErrorBoundary.show(error.message || 'Failed to join game', 'error');
    }
}

async function startMultiplayerGame() {
    if (!gameId) return;
    
    try {
        const response = await CSRFManager.fetch(gameRequestUrl(`/games/${gameId}/start`), {
            method: 'POST'
        });
        
        if (!response.ok) {
            throw new Error(await getErrorMessage(response, 'Failed to start game'));
        }
        
        const data = await response.json();
        clearInterval(lobbyPollInterval);
        updateGameState(data);
        switchScreen('game');
        updateGameDisplay();
        startPolling();
        
    } catch (error) {
        console.error('Error starting game:', error);
        ErrorBoundary.show(error.message || 'Failed to start game', 'error');
    }
}

function startPolling() {
    // Clear any existing polling
    stopPolling();
    
    // Don't process AI for multiplayer games
    const processAI = gameState?.game_type !== 'multiplayer';
    
    pollIntervalId = setInterval(async () => {
        if (pollInFlight) return;

        if (!gameId || !playerId) {
            stopPolling();
            return;
        }

        pollInFlight = true;
        
        try {
            const response = await fetch(gameRequestUrl(`/games/${gameId}`, { process_ai: String(processAI) }));
            if (!response.ok) {
                if (response.status === 404) {
                    stopPolling();
                }
                return;
            }
            
            const newState = await response.json();
            updateGameState(newState);
            updateGameDisplay();
            
            if (gameState.phase === 'showdown') {
                stopPolling();
                showHandResult();
            }
            
        } catch (error) {
            console.error('Polling error:', error);
        } finally {
            pollInFlight = false;
        }
    }, AI_POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
    pollInFlight = false;
}

async function playerAction(action) {
    if (!isMyTurn && action !== 'fold') return;
    
    // Stop timer when action is taken
    stopTurnTimer();
    
    // Prevent race condition - ignore if request already pending
    if (isRequestPending) {
        console.log('Action ignored - request already in progress');
        return;
    }
    
    let amount = null;
    if (action === 'raise') {
        amount = raiseAmount;
    }
    
    isRequestPending = true;
    
    try {
        const body = { player_id: playerId, player_token: playerToken, action };
        if (amount !== null) body.amount = amount;
        if (actionToken) body.action_token = actionToken; // Include anti-replay token
        
        const response = await CSRFManager.fetch(`${API_BASE}/api/poker/games/${gameId}/action`, {
            method: 'POST',
            body: JSON.stringify(body)
        });
        
        if (!response.ok) throw new Error('Action failed');
        
        const responseData = await response.json();
        updateGameState(responseData);
        
        // Update chat messages if present
        if (gameState.chat_messages) {
        }
        
        hideRaiseControls();
        
        // Play chip sound for betting actions
        if (action === 'raise' || action === 'call') {
            SoundManager.playChip();
        }
        
        updateGameDisplay();
        startPolling();
        
        if (gameState.phase === 'showdown') {
            showHandResult();
        }
        
    } catch (error) {
        console.error('Error performing action:', error);
        ErrorBoundary.show('Action failed. Please try again.', 'error');
    } finally {
        isRequestPending = false;
    }
}

function showRaiseControls() {
    const myPlayer = gameState?.players?.find(p => p.id === playerId);
    if (!myPlayer) return;
    
    const toCall = (gameState?.current_bet || 0) - (myPlayer?.bet || 0);
    const minRaise = gameState?.min_raise || 20;
    const minTotal = toCall + minRaise;
    
    // Check if player can afford minimum raise
    if (myPlayer.chips < minTotal) {
        // Can't raise, auto-call or all-in
        if (myPlayer.chips <= toCall) {
            playerAction('call'); // Will become all-in
        }
        return;
    }
    
    elements.raiseSlider.min = minTotal;
    elements.raiseSlider.max = myPlayer.chips;
    elements.raiseSlider.value = minTotal;
    raiseAmount = minTotal;
    elements.raiseDisplay.textContent = minTotal;

    // Update slider labels
    if (elements.sliderMin) elements.sliderMin.textContent = `Min: ${minTotal}`;
    if (elements.sliderMax) elements.sliderMax.textContent = `Max: ${myPlayer.chips}`;

    elements.raiseContainer.classList.remove('hidden');
    elements.actionButtons.classList.add('hidden');
}

function hideRaiseControls() {
    elements.raiseContainer.classList.add('hidden');
    elements.actionButtons.classList.remove('hidden');
}

function confirmRaise() {
    playerAction('raise');
}

function handleShowdownPrimaryAction() {
    const myPlayer = gameState?.players?.find(p => p.id === playerId);
    if (myPlayer && myPlayer.chips <= 0) {
        buyBackIn();
        return;
    }
    nextHand();
}

async function nextHand() {
    // Prevent race condition
    if (isRequestPending) {
        console.log('Next hand ignored - request already in progress');
        return;
    }

    isRequestPending = true;

    // Clear seen cards and reset deal sequence for new hand (so they animate again)
    seenCards.clear();
    resetCardDealSequence();

    try {
        elements.btnNextHand.disabled = true;
        showLoading('Dealing next hand...');

        const response = await CSRFManager.fetch(gameRequestUrl(`/games/${gameId}/next-hand`), {
            method: 'POST'
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || err.message || 'Failed to start next hand');
        }

        const responseData = await response.json();
        updateGameState(responseData);
        
        hideLoading();
        hideHandResult();
        updateGameDisplay();

        // Restart polling for the new hand
        startPolling();

    } catch (error) {
        console.error('Error starting next hand:', error);
        hideLoading();
        const message = typeof error === 'string' ? error : (error.message || 'Failed to start next hand');
        ErrorBoundary.show(message, 'error');
    } finally {
        isRequestPending = false;
        elements.btnNextHand.disabled = false;
        elements.btnNextHand.textContent = 'Ready for Next Hand';
    }
}

function updateGameDisplay() {
    if (!gameState) return;
    const isShowdown = gameState.phase === 'showdown';

    // Track new hands for stats
    if (gameState.hand_number && gameState.hand_number !== lastHandNumber) {
        if (lastHandNumber > 0) {
            // Previous hand completed, record it
            StatsManager.recordHandPlayed();
        }
        lastHandNumber = gameState.hand_number;
        handResultRecorded = false; // Reset for new hand
    }

    // Update header
    elements.handNumber.textContent = gameState.hand_number;
    elements.phase.textContent = gameState.phase.replace('_', ' ').toUpperCase();
    elements.potAmount.innerHTML = ChipStackVisualizer.render(gameState.pot, true, true);
    elements.gameScreen?.classList.toggle('showdown-active', isShowdown);
    if (!isShowdown) {
        hideHandResult();
    }
    
    // Check if it's your turn
    const isYourTurn = gameState.current_player === playerId && !isShowdown;
    
    // Update your info
    const myPlayer = gameState.players.find(p => p.id === playerId);
    if (myPlayer) {
        elements.yourChips.innerHTML = ChipStackVisualizer.render(myPlayer.chips, true, true);
        document.querySelector('.your-avatar-container')?.remove();
        
        // Your cards with staggered animation (deal player cards first)
        const cardsHTML = myPlayer.hand.map((card, index) => renderCard(card, true, index)).join('');
        elements.yourCards.innerHTML = cardsHTML;
        
        // Show hand strength (only update if changed to prevent re-animation)
        const handStrength = evaluateHandStrength(myPlayer.hand, gameState.community_cards);
        const currentStrength = elements.handStrength.textContent;
        if (handStrength && handStrength !== currentStrength) {
            const strengthText = document.createElement('span');
            strengthText.className = 'hand-strength-text';
            strengthText.textContent = handStrength;
            elements.handStrength.replaceChildren(strengthText);
        } else if (!handStrength) {
            elements.handStrength.replaceChildren();
        }
        
        // Show AI action indicator
        if (gameState.last_ai_action) {
            const action = gameState.last_ai_action;
            const actionText = `${action.player_name}: ${formatActionLabel(action)}`;
            const aiActionText = document.createElement('span');
            aiActionText.className = 'ai-action-text';
            aiActionText.textContent = actionText;
            elements.aiActionIndicator.replaceChildren(aiActionText);
        } else {
            elements.aiActionIndicator.replaceChildren();
        }
        
        // Add/remove active-turn class
        if (isYourTurn) {
            elements.yourCards.classList.add('active-turn');
        } else {
            elements.yourCards.classList.remove('active-turn');
        }
        const isHumanWinner = gameState.winners?.some(w => w.id === playerId);
        elements.yourCards.classList.toggle('winner-hand', Boolean(isShowdown && isHumanWinner));
    }
    
    // Update opponents in the same clockwise order the game engine uses.
    const opponents = getClockwiseOpponents(gameState.players, playerId);
    elements.opponentsRow.innerHTML = opponents.map(({ player, seatClass }) => renderOpponent(player, seatClass)).join('');
    
    // Update community cards with staggered animation (offset by 2 for player cards)
    const community = gameState.community_cards;
    elements.communityCards.innerHTML = `
        <div class="card-slot" id="flop-1">${community[0] ? renderCard(community[0], false, 2) : ''}</div>
        <div class="card-slot" id="flop-2">${community[1] ? renderCard(community[1], false, 3) : ''}</div>
        <div class="card-slot" id="flop-3">${community[2] ? renderCard(community[2], false, 4) : ''}</div>
        <div class="card-slot" id="turn">${community[3] ? renderCard(community[3], false, 2) : ''}</div>
        <div class="card-slot" id="river">${community[4] ? renderCard(community[4], false, 2) : ''}</div>
    `;
    
    // Update action buttons
    updateActionButtons();
    
    // Handle turn timer
    if (isYourTurn && gameState.phase !== 'showdown') {
        if (!turnTimerId) {
            startTurnTimer();
        }
        // Trigger haptic feedback when it's player's turn (once per turn)
        if (!hasVibratedThisTurn) {
            triggerHapticFeedback();
            hasVibratedThisTurn = true;
        }
    } else {
        stopTurnTimer();
        hasVibratedThisTurn = false; // Reset when turn ends
    }
}

function getClockwiseOpponents(players, heroId) {
    if (!Array.isArray(players) || players.length <= 1) return [];

    const heroIndex = players.findIndex(p => p.id === heroId);
    const startIndex = heroIndex >= 0 ? heroIndex : 0;
    const orderedPlayers = [];

    for (let offset = 1; offset < players.length; offset++) {
        orderedPlayers.push(players[(startIndex + offset) % players.length]);
    }

    const seatClasses = CLOCKWISE_OPPONENT_SEATS[orderedPlayers.length] || CLOCKWISE_OPPONENT_SEATS[5];
    return orderedPlayers.map((player, index) => ({
        player,
        seatClass: seatClasses[index] || `seat-${index + 1}`
    }));
}

function renderOpponent(player, seatClass = 'seat-1') {
    const isCurrent = gameState.phase !== 'showdown' && gameState.current_player === player.id;
    const isShowdown = gameState.phase === 'showdown';
    const showCards = gameState.phase === 'showdown' && !player.folded;
    const isWinner = gameState.winners?.some(w => w.id === player.id);
    const recentAIAction = gameState.last_ai_action?.player_name === player.name ? gameState.last_ai_action : null;
    const recentActionClass = recentAIAction ? 'recent-ai-action' : '';
    const actionLabel = recentAIAction ? formatActionLabel(recentAIAction) : '';

    return `
        <div class="opponent ${seatClass} ${recentActionClass} ${player.folded ? 'folded' : ''} ${isCurrent ? 'active-turn' : ''} ${isWinner ? 'winner' : ''}">
            <div class="opponent-cards">
                ${showCards
                    ? player.hand.map(c => renderCard(c)).join('')
                    : isShowdown
                        ? ''
                    : `<div class="card-back ${player.folded ? 'folded' : ''}">🂠</div><div class="card-back ${player.folded ? 'folded' : ''}">🂠</div>`
                }
            </div>
            <span class="opponent-name">${escapeHtml(player.name)}</span>
            <span class="opponent-chips">${ChipStackVisualizer.renderCompact(player.chips)}</span>
            ${player.bet > 0 ? `<span class="opponent-bet">${ChipStackVisualizer.renderCompact(player.bet)}</span>` : ''}
            ${actionLabel ? `<span class="opponent-action-badge">${escapeHtml(actionLabel)}</span>` : ''}
        </div>
    `;
}

function formatActionLabel(action) {
    if (!action) return '';
    const label = String(action.action || '').replace('-', ' ').toUpperCase();
    return action.amount ? `${label} ${action.amount}` : label;
}

// Track card deal sequences for staggered animations
let cardDealSequence = 0;
let lastCommunityCount = 0;

function resetCardDealSequence() {
    cardDealSequence = 0;
    lastCommunityCount = 0;
}

function renderCard(card, isPlayerCard = false, dealIndex = null) {
    // Handle null/undefined cards
    if (!card || typeof card !== 'object') return '';
    
    // Handle missing suit or rank
    if (!card.suit || card.rank === undefined || card.rank === null) return '';
    
    const isRed = card.suit === 'HEARTS' || card.suit === 'DIAMONDS';
    const suitSymbol = { 'HEARTS': '♥', 'DIAMONDS': '♦', 'CLUBS': '♣', 'SPADES': '♠' }[card.suit] || '';
    const rank = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' }[card.rank] ?? String(Number(card.rank));
    
    // Create unique card ID to track if we've seen it before
    const cardId = `${card.suit}-${card.rank}`;
    const isNewCard = !seenCards.has(cardId);
    
    // Only animate if this is a new card we haven't seen before
    if (isNewCard) {
        seenCards.add(cardId);
    }
    
    // Use staggered animation class if deal index provided and card is new
    let animationClass = '';
    if (isNewCard && dealIndex !== null) {
        const staggerIndex = Math.min(dealIndex + 1, 5); // cap at 5
        animationClass = `card-deal-${staggerIndex}`;
    } else if (isNewCard) {
        animationClass = 'new-card';
    }
    
    // Use inline style for color to ensure it works
    const colorStyle = isRed ? 'color:#dc3545' : 'color:#1a1a2e';
    return `<div class="card ${animationClass} ${isRed ? 'red' : 'black'}" style="${colorStyle}">${rank}${suitSymbol}</div>`;
}

function evaluateHandStrength(playerCards, communityCards) {
    if (!playerCards || playerCards.length < 2) return null;
    
    const allCards = [...playerCards, ...communityCards];
    if (allCards.length < 5) return null; // Need at least 5 cards to evaluate
    
    const ranks = allCards.map(c => c.rank);
    const suits = allCards.map(c => c.suit);
    
    // Count ranks
    const rankCounts = {};
    ranks.forEach(r => rankCounts[r] = (rankCounts[r] || 0) + 1);
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    
    // Count suits
    const suitCounts = {};
    suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
    const maxSuitCount = Math.max(...Object.values(suitCounts));
    
    // Check for flush
    const isFlush = maxSuitCount >= 5;
    
    // Check for straight
    const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
    let isStraight = false;
    let straightHigh = 0;
    
    for (let i = 0; i <= uniqueRanks.length - 5; i++) {
        if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) {
            isStraight = true;
            straightHigh = uniqueRanks[i];
            break;
        }
    }
    // Check wheel (A-5)
    if (!isStraight && uniqueRanks.includes(14) && uniqueRanks.includes(5) && 
        uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) {
        isStraight = true;
        straightHigh = 5;
    }
    
    // Get rank names for display
    const rankNames = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack' };
    const pluralize = (rank) => {
        const name = rankNames[rank] || rank;
        return name + (rank !== 6 && rank !== 9 && rank !== 10 ? 's' : 'es');
    };
    
    const getRankName = (rank) => rankNames[rank] || rank;
    
    // Find the ranks with specific counts
    const getRanksWithCount = (n) => {
        return Object.entries(rankCounts)
            .filter(([r, c]) => c === n)
            .map(([r, c]) => parseInt(r))
            .sort((a, b) => b - a);
    };
    
    // Determine hand rank
    if (isFlush && isStraight) {
        if (straightHigh === 14) return 'Royal Flush! 👑';
        return `Straight Flush - ${getRankName(straightHigh)} high`;
    }
    
    if (counts[0] === 4) {
        const quadRank = getRanksWithCount(4)[0];
        return `Four of a Kind - ${pluralize(quadRank)}`;
    }
    
    if (counts[0] === 3 && counts[1] >= 2) {
        const tripRank = getRanksWithCount(3)[0];
        const pairRank = getRanksWithCount(2)[0];
        return `Full House - ${pluralize(tripRank)} full of ${pluralize(pairRank)}`;
    }
    
    if (isFlush) return 'Flush';
    
    if (isStraight) {
        return `Straight - ${getRankName(straightHigh)} high`;
    }
    
    if (counts[0] === 3) {
        const tripRank = getRanksWithCount(3)[0];
        return `Three of a Kind - ${pluralize(tripRank)}`;
    }
    
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = getRanksWithCount(2);
        return `Two Pair - ${pluralize(pairs[0])} and ${pluralize(pairs[1])}`;
    }
    
    if (counts[0] === 2) {
        const pairRank = getRanksWithCount(2)[0];
        return `Pair of ${pluralize(pairRank)}`;
    }
    
    // High card - show the best card
    const highCard = Math.max(...ranks);
    return `${getRankName(highCard)} High`;
}

// Get hand name from exactly 5 cards (for winner display)
function getHandNameFrom5Cards(cards) {
    if (!cards || cards.length !== 5) return null;
    
    const ranks = cards.map(c => c.rank);
    const suits = cards.map(c => c.suit);
    
    // Count ranks
    const rankCounts = {};
    ranks.forEach(r => rankCounts[r] = (rankCounts[r] || 0) + 1);
    const counts = Object.values(rankCounts).sort((a, b) => b - a);
    
    // Count suits
    const suitCounts = {};
    suits.forEach(s => suitCounts[s] = (suitCounts[s] || 0) + 1);
    const maxSuitCount = Math.max(...Object.values(suitCounts));
    
    // Check for flush
    const isFlush = maxSuitCount === 5;
    
    // Check for straight
    const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
    let isStraight = false;
    let straightHigh = 0;
    
    if (uniqueRanks.length === 5) {
        if (uniqueRanks[0] - uniqueRanks[4] === 4) {
            isStraight = true;
            straightHigh = uniqueRanks[0];
        }
        // Check wheel (A-5)
        else if (uniqueRanks.includes(14) && uniqueRanks.includes(5) && 
            uniqueRanks.includes(4) && uniqueRanks.includes(3) && uniqueRanks.includes(2)) {
            isStraight = true;
            straightHigh = 5;
        }
    }
    
    // Get rank names
    const rankNames = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack' };
    const getRankName = (rank) => rankNames[rank] || rank;
    
    const getRanksWithCount = (n) => {
        return Object.entries(rankCounts)
            .filter(([r, c]) => c === n)
            .map(([r, c]) => parseInt(r))
            .sort((a, b) => b - a);
    };
    
    // Determine hand name
    if (isFlush && isStraight) {
        if (straightHigh === 14) return 'Royal Flush! 👑';
        return `Straight Flush`;
    }
    
    if (counts[0] === 4) {
        const quadRank = getRanksWithCount(4)[0];
        return `Four of a Kind - ${getRankName(quadRank)}s`;
    }
    
    if (counts[0] === 3 && counts[1] === 2) {
        const tripRank = getRanksWithCount(3)[0];
        const pairRank = getRanksWithCount(2)[0];
        return `Full House - ${getRankName(tripRank)}s full of ${getRankName(pairRank)}s`;
    }
    
    if (isFlush) return 'Flush';
    
    if (isStraight) {
        return `Straight - ${getRankName(straightHigh)} high`;
    }
    
    if (counts[0] === 3) {
        const tripRank = getRanksWithCount(3)[0];
        return `Three of a Kind - ${getRankName(tripRank)}s`;
    }
    
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = getRanksWithCount(2);
        return `Two Pair - ${getRankName(pairs[0])}s and ${getRankName(pairs[1])}s`;
    }
    
    if (counts[0] === 2) {
        const pairRank = getRanksWithCount(2)[0];
        return `Pair of ${getRankName(pairRank)}s`;
    }
    
    // High card
    const highCard = Math.max(...ranks);
    return `${getRankName(highCard)} High`;
}

function updateActionButtons() {
    if (!gameState || gameState.phase === 'showdown') {
        elements.actionButtons.classList.add('hidden');
        return;
    }
    
    const myPlayer = gameState.players.find(p => p.id === playerId);
    isMyTurn = gameState.current_player === playerId;
    
    if (!isMyTurn || !myPlayer) {
        elements.actionButtons.classList.add('hidden');
        return;
    }
    
    elements.actionButtons.classList.remove('hidden');
    
    const toCall = gameState.current_bet - myPlayer.bet;
    
    if (toCall === 0) {
        elements.btnCall.textContent = 'Check';
    } else {
        const callAmount = Math.min(toCall, myPlayer.chips);
        elements.btnCall.textContent = myPlayer.chips <= toCall ? 'All In' : `Call ${callAmount}`;
    }
    
    // Hide raise button if can't afford min raise
    const minRaise = gameState.min_raise || 20;
    const canRaise = myPlayer.chips > toCall + minRaise;
    if (canRaise) {
        elements.btnRaise.classList.remove('hidden');
        elements.btnRaise.disabled = false;
        elements.btnRaise.style.opacity = '1';
    } else {
        elements.btnRaise.classList.add('hidden');
    }
}

function showHandResult() {
    if (!gameState.winners || gameState.winners.length === 0) return;

    // Update display one more time to show all cards
    updateGameDisplay();

    const winner = gameState.winners[0];
    const isMe = winner.id === playerId;
    const myPlayer = gameState.players.find(p => p.id === playerId);
    const isBusted = Boolean(myPlayer && myPlayer.chips <= 0);

    // Record stats for hand result (only once per hand)
    if (!handResultRecorded) {
        handResultRecorded = true;
        if (isMe) {
            // Get hand strength text if available
            const handStrengthEl = elements.handStrength.querySelector('.hand-strength-text');
            const handName = handStrengthEl ? handStrengthEl.textContent : null;
            StatsManager.recordHandWin(winner.amount, handName);
        } else if (myPlayer) {
            // Record loss (amount lost is player's bet this hand)
            StatsManager.recordHandLoss(myPlayer.bet || 0);
        }
    }
    
    // Play win/loss sound
    if (isMe) {
        SoundManager.playWin();
    } else {
        SoundManager.playLoss();
    }
    
    const handName = winner.hand && winner.hand.length > 0 ? getHandNameFrom5Cards(winner.hand) : '';
    const winnerNames = gameState.winners.map(w => w.name).join(', ');
    const totalWon = gameState.winners.reduce((sum, w) => sum + (w.amount || 0), 0);

    elements.showdownTitle.textContent = isMe ? 'You win' : `${winnerNames} ${gameState.winners.length > 1 ? 'win' : 'wins'}`;
    elements.showdownDetails.textContent = isBusted
        ? `${handName || 'Best hand'} - ${totalWon} chips awarded. Buy back to keep playing.`
        : `${handName || 'Best hand'} - ${totalWon} chips awarded.`;
    elements.btnNextHand.textContent = isBusted ? 'Buy Back In' : 'Ready for Next Hand';
    elements.btnNextHand.disabled = false;
    elements.showdownPanel.classList.remove('hidden');
}

function hideHandResult() {
    elements.showdownPanel?.classList.add('hidden');
}

function showBuyBackOverlay() {
    const myPlayer = gameState.players.find(p => p.id === playerId);
    if (elements.finalChipCount) {
        elements.finalChipCount.textContent = `Final: ${myPlayer?.chips || 0} chips`;
    }
    
    // Play loss sound
    SoundManager.playLoss();
    
    if (elements.buyBackOverlay) {
        elements.buyBackOverlay.classList.remove('hidden');
    }
}

function hideBuyBackOverlay() {
    if (elements.buyBackOverlay) {
        elements.buyBackOverlay.classList.add('hidden');
    }
}

async function buyBackIn() {
    if (isRequestPending || !gameId || !playerId) return;

    isRequestPending = true;
    try {
        const response = await CSRFManager.fetch(`${API_BASE}/api/poker/games/${gameId}/buy-back`, {
            method: 'POST',
            body: JSON.stringify({ player_id: playerId, player_token: playerToken, amount: 1000 })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || err.message || 'Buy-back failed');
        }

        const responseData = await response.json();
        updateGameState(responseData);
        hideBuyBackOverlay();
        updateGameDisplay();
        showHandResult();
    } catch (error) {
        console.error('Buy-back failed:', error);
        ErrorBoundary.show(error.message || 'Buy-back failed. Please try again.', 'error');
    } finally {
        isRequestPending = false;
    }
}

function endGame() {
    hideBuyBackOverlay();
    
    // Show final stats
    const stats = StatsManager.getFormattedStats();
    const myPlayer = gameState.players.find(p => p.id === playerId);
    const finalChips = myPlayer?.chips || 0;
    
    // Create end game summary
    let summaryHTML = `
        <div style="text-align: center; margin-bottom: 20px;">
            <h3 style="color: #ffd700; margin-bottom: 10px;">🎮 Game Over</h3>
            <p style="font-size: 1.2rem;">Final Chip Count: <span style="color: ${finalChips >= 1000 ? '#10b981' : '#ef4444'}; font-weight: 700;">${finalChips}</span></p>
            <p style="font-size: 0.9rem; color: #94a3b8; margin-top: 5px;">Started with: 1000 chips</p>
        </div>
        <div class="stat-row">
            <span class="stat-label">Hands Played</span>
            <span class="stat-value">${stats.handsPlayed}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Hands Won</span>
            <span class="stat-value gold">${stats.handsWon}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Win Rate</span>
            <span class="stat-value gold">${stats.winRate}%</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Biggest Pot Won</span>
            <span class="stat-value gold">${stats.biggestPotWon} chips</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Net Profit/Loss</span>
            <span class="stat-value ${stats.netProfit >= 0 ? 'positive' : 'negative'}">${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit} chips</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Best Hand</span>
            <span class="stat-value">${escapeHtml(stats.bestHand)}</span>
        </div>
    `;
    
    elements.statsContent.innerHTML = summaryHTML;
    elements.statsModal.classList.remove('hidden');
    
    // Reset game state after showing stats
    setTimeout(() => {
        gameState = null;
        playerId = null;
        playerToken = null;
        gameId = null;
        switchScreen('start');
    }, 100);
}

function showStats() {
    const stats = StatsManager.getFormattedStats();
    const netProfitClass = stats.netProfit >= 0 ? 'positive' : 'negative';

    elements.statsContent.innerHTML = `
        <div class="stat-row">
            <span class="stat-label">Hands Played</span>
            <span class="stat-value">${stats.handsPlayed}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Hands Won</span>
            <span class="stat-value gold">${stats.handsWon}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Win Rate</span>
            <span class="stat-value gold">${stats.winRate}%</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Biggest Pot Won</span>
            <span class="stat-value gold">${stats.biggestPotWon} chips</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Net Profit/Loss</span>
            <span class="stat-value ${netProfitClass}">${stats.netProfit >= 0 ? '+' : ''}${stats.netProfit} chips</span>
        </div>
        <div class="stat-row">
            <span class="stat-label">Best Hand</span>
            <span class="stat-value">${escapeHtml(stats.bestHand)}</span>
        </div>
    `;
    elements.statsModal.classList.remove('hidden');
}

function hideStats() {
    elements.statsModal.classList.add('hidden');
}

function switchScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');

    // Lock orientation to portrait when entering game screen on mobile
    if (screenName === 'game') {
        lockOrientationPortrait();
        // Initialize gesture manager when entering game screen
        GestureManager.init();
    }
}

// Orientation Lock Function
function lockOrientationPortrait() {
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('portrait').catch((err) => {
            console.log('[Orientation] Could not lock orientation:', err.message);
        });
    }
}

// Decision Timer Functions
function startTurnTimer() {
    stopTurnTimer(); // Clear any existing timer
    
    turnStartTime = Date.now();
    elements.decisionTimer.classList.remove('hidden');
    
    updateTimerDisplay();
    
    // Update every 100ms for smooth countdown
    turnTimerId = setInterval(() => {
        updateTimerDisplay();
        
        const elapsed = Date.now() - turnStartTime;
        if (elapsed >= TURN_TIME_LIMIT) {
            stopTurnTimer();
            // Auto-fold on timeout
            elements.timerText.textContent = 'Time up! Folding...';
            elements.timerText.classList.add('urgent');
            setTimeout(() => {
                playerAction('fold');
            }, 500);
        }
    }, 100);
}

function stopTurnTimer() {
    if (turnTimerId) {
        clearInterval(turnTimerId);
        turnTimerId = null;
    }
    turnStartTime = null;
    if (elements.decisionTimer) {
        elements.decisionTimer.classList.add('hidden');
    }
    if (elements.timerText) {
        elements.timerText.classList.remove('urgent');
    }
}

function updateTimerDisplay() {
    if (!turnStartTime || !elements.timerText || !elements.timerFill) return;
    
    const elapsed = Date.now() - turnStartTime;
    const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
    const seconds = Math.ceil(remaining / 1000);
    const percentage = (remaining / TURN_TIME_LIMIT) * 100;
    
    elements.timerText.textContent = `Your turn - ${seconds}s`;
    elements.timerFill.style.width = `${percentage}%`;
    
    // Add urgency styling when time is low
    if (seconds <= 5) {
        elements.timerText.classList.add('urgent');
    } else {
        elements.timerText.classList.remove('urgent');
    }
}

// Haptic Feedback Function
function triggerHapticFeedback() {
    // Check if vibration API is supported and device is mobile
    if (typeof navigator !== 'undefined' && navigator.vibrate && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        try {
            // Pattern: 50ms vibration, 100ms pause, 50ms vibration (double tap feel)
            navigator.vibrate([50, 100, 50]);
            console.log('[Haptic] Turn notification vibrated');
        } catch (e) {
            // Silently fail if vibration is blocked or fails
            console.log('[Haptic] Vibration failed:', e.message);
        }
    }
}
