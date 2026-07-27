// Poker Game Frontend - Oval Table Design
// API_BASE is the API origin, shared across all static apps. See
// /shared/api-base.js for the source of truth and how to override it.
const API_BASE = (typeof window !== 'undefined' && typeof window.API_ORIGIN === 'string')
    ? window.API_ORIGIN
    : '';

const APIRequest = {
    REQUEST_TIMEOUT_MS: 12000,

    getHeaders(contentType = 'application/json') {
        return { 'Content-Type': contentType };
    },

    async fetch(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const stateChangingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

        if (stateChangingMethods.includes(method)) {
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
        // Swipe left to fold. Guard on gameState so a pre-load swipe doesn't
        // fire a no-op fold against null state.
        if (gameState && isMyTurn && gameState.phase !== 'showdown') {
            this.showGestureFeedback('Fold', 'left');
            playerAction('fold');
        }
    },

    handleSwipeRight() {
        // Swipe right to check (if possible) or show feedback
        if (gameState && isMyTurn && gameState.phase !== 'showdown') {
            const myPlayer = gameState.players.find(p => p.id === playerId);
            const toCall = (gameState.current_bet || 0) - (myPlayer?.bet || 0);

            if (toCall === 0) {
                this.showGestureFeedback('Check', 'right');
                playerAction('check');
            } else {
                this.showGestureFeedback('Check not available', 'right', true);
            }
        }
    },

    handleDoubleTap() {
        // Double tap to call
        if (isMyTurn && gameState?.phase !== 'showdown') {
            const myPlayer = gameState.players.find(p => p.id === playerId);
            const toCall = (gameState.current_bet || 0) - (myPlayer?.bet || 0);

            if (toCall > 0) {
                this.showGestureFeedback('Call', 'center');
                playerAction('call');
            } else {
                this.showGestureFeedback('Check', 'center');
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
    HAND_HISTORY_KEY: 'poker-hand-history',
    HAND_HISTORY_MAX: 20,
    history: [],

    loadHistory() {
        try {
            const raw = localStorage.getItem(this.HAND_HISTORY_KEY);
            if (!raw) { this.history = []; return; }
            const parsed = JSON.parse(raw);
            this.history = Array.isArray(parsed) ? parsed.slice(0, this.HAND_HISTORY_MAX) : [];
        } catch { this.history = []; }
    },

    saveHistory() {
        try {
            localStorage.setItem(
                this.HAND_HISTORY_KEY,
                JSON.stringify(this.history.slice(0, this.HAND_HISTORY_MAX))
            );
        } catch {}
    },

    recordHand({ result, amount, handName, holeCards, board }) {
        const entry = {
            ts: Date.now(),
            result, // 'win' | 'loss' | 'chop'
            amount: Number(amount) || 0,
            handName: handName || null,
            holeCards: Array.isArray(holeCards) ? holeCards.slice(0, 2) : null,
            board: Array.isArray(board) ? board.slice(0, 5) : null
        };
        this.history.unshift(entry);
        if (this.history.length > this.HAND_HISTORY_MAX) {
            this.history.length = this.HAND_HISTORY_MAX;
        }
        this.saveHistory();
    },

    clearHistory() {
        this.history = [];
        this.saveHistory();
    },

    init() {
        // Load saved stats from localStorage
        const saved = localStorage.getItem('poker-stats');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                this.stats = { ...this.stats, ...parsed };
            } catch {
                console.log('[Stats] Failed to load saved stats');
            }
        }
        this.stats.sessionStart = new Date().toISOString();
        this.loadHistory();
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
        // Coerce all numeric fields. Stats round-trip through localStorage, and a
        // tampered store could otherwise inject HTML strings into the templates
        // below (which write via innerHTML).
        const toInt = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.trunc(n) : 0;
        };
        return {
            handsPlayed: toInt(this.stats.handsPlayed),
            handsWon: toInt(this.stats.handsWon),
            winRate: this.getWinRate(),
            biggestPotWon: toInt(this.stats.biggestPotWon),
            netProfit: toInt(this.getNetProfit()),
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
const AI_POLL_INTERVAL_MS = 1800;
// Betting rounds: the label on the table, the explanation on hover.
const PHASES = {
    waiting: { label: 'Waiting', tip: 'Waiting for the hand to start' },
    preflop: { label: 'Preflop', tip: 'Two hole cards each, no community cards yet' },
    flop: { label: 'Flop', tip: 'First three community cards are out' },
    turn: { label: 'Turn', tip: 'Fourth community card is out' },
    river: { label: 'River', tip: 'Fifth and last community card is out' },
    showdown: { label: 'Showdown', tip: 'Cards face up — best five-card hand takes the pot' }
};

const CLOCKWISE_OPPONENT_SEATS = {
    1: ['seat-1'],
    2: ['seat-2', 'seat-3'],
    3: ['seat-2', 'seat-1', 'seat-3'],
    4: ['seat-4', 'seat-2', 'seat-3', 'seat-5'],
    5: ['seat-4', 'seat-2', 'seat-1', 'seat-3', 'seat-5']
};

function updateGameState(newState) {
    gameState = newState;
}
let turnStartTime = null;
let turnTimerId = null;
const TURN_TIME_LIMIT = 30000; // 30 seconds per turn
let hasVibratedThisTurn = false; // Track if we've vibrated for current turn
let seenCards = new Set(); // Track cards we've already animated
let lastHandNumber = 0; // Track hand number for stats
let handResultRecorded = false; // Prevent duplicate stat recording
let dismissedShowdownHand = null;

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
        player_id: playerId
    });
    return `${API_BASE}/api/poker${path}?${query.toString()}`;
}

function playerAuthHeaders(headers = {}) {
    return playerToken
        ? { 'X-Player-Token': playerToken, ...headers }
        : { ...headers };
}

function calculateRaiseSizeForRequest(totalCommitment, currentBet, playerBet) {
    const toCall = Math.max(0, (Number(currentBet) || 0) - (Number(playerBet) || 0));
    return Math.max(0, (Number(totalCommitment) || 0) - toCall);
}

if (typeof window !== 'undefined') {
    window.PokerRaiseMath = { calculateRaiseSizeForRequest };
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
    hudBlinds: document.getElementById('hud-blinds'),
    potAmount: document.getElementById('pot-amount'),
    opponentsRow: document.getElementById('opponents-row'),
    communityCards: document.getElementById('community-cards'),
    yourCards: document.getElementById('your-cards'),
    handStrength: document.getElementById('hand-strength'),
    aiActionIndicator: document.getElementById('ai-action-indicator'),
    yourName: document.getElementById('your-name'),
    yourPositionChip: document.getElementById('your-position-chip'),
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
    btnDismissShowdown: document.getElementById('btn-dismiss-showdown'),
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
    btnResetStats: document.getElementById('btn-reset-stats')
};

// Chip amounts read as numbers, not as stacks of decorative discs: at a glance
// a player wants the count, and the thousands separator is what makes it
// scannable.
function formatChips(amount) {
    const n = Number(amount) || 0;
    return n.toLocaleString('en-US');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Initialize error boundary, sound manager, and stats
    ErrorBoundary.init();
    SoundManager.init();
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
    const tournamentBtn = document.getElementById('start-tournament-btn');
    if (tournamentBtn) {
        tournamentBtn.addEventListener('click', () => startGame('tournament'));
    }
    
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
    elements.btnDismissShowdown?.addEventListener('click', dismissShowdownPopup);
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

    let detail = typeof payload === 'string'
        ? payload
        : payload?.detail || payload?.message || payload?.error;

    // Non-JSON failures (proxy/static-server error pages) come back as HTML —
    // surface a readable message instead of dumping markup into the toast.
    if (typeof detail === 'string' && /<[a-z][\s\S]*>/i.test(detail)) {
        detail = `Server error (${response.status})`;
    }

    if (response.status === 404 && /Application not found/i.test(detail || '')) {
        return 'Poker API is unavailable. The production API backend is not responding.';
    }

    return detail || fallback;
}

async function startGame(gameType = 'single') {
    const name = elements.playerName.value.trim() || 'Palmer';
    window.CasinoProfile?.setDisplayName(name);

    // Clear seen cards for a new game so card deal animations can replay.
    seenCards.clear();

    try {
        elements.startBtn.disabled = true;
        showLoading('Starting game...');

        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games`, {
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
        window.pgAnalytics?.track?.('poker_game_started', { game_type: gameType });
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
            const response = await APIRequest.fetch(
                gameRequestUrl(`/games/${gameId}`, { process_ai: 'false' }),
                { headers: playerAuthHeaders() }
            );
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
    window.CasinoProfile?.setDisplayName(name);
    const joinGameId = gameIdInput?.value?.trim();
    
    if (!joinGameId) {
        ErrorBoundary.show('Please enter a Game ID', 'error');
        return;
    }
    
    try {
        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games/join`, {
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
        window.pgAnalytics?.track?.('poker_multiplayer_joined');
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
        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games/${gameId}/start`, {
            method: 'POST',
            body: JSON.stringify({ player_id: playerId, player_token: playerToken })
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

    // Open the WS push channel alongside polling. Polling stays as a fallback
    // (and primary cadence) so a missed WS frame still resolves within ~3s.
    if (gameId) connectGameWs(gameId);

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
            const response = processAI
                ? await APIRequest.fetch(`${API_BASE}/api/poker/games/${gameId}/process-ai`, {
                    method: 'POST',
                    body: JSON.stringify({ player_id: playerId, player_token: playerToken })
                })
                : await APIRequest.fetch(
                    gameRequestUrl(`/games/${gameId}`, { process_ai: 'false' }),
                    { headers: playerAuthHeaders() }
                );
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
    disconnectGameWs();
}

// ── Realtime WebSocket push channel ──────────────────────────────────────
// When the server pings us with `{type:"state_changed"}`, we trigger an
// immediate fetch instead of waiting for the next poll cycle. Polling stays
// in place as a fallback (and as the primary mechanism if the WS connection
// can't be established or drops repeatedly).
let gameWs = null;
let gameWsReconnectTimer = null;
let gameWsReconnectAttempts = 0;
let gameWsBackoffUntil = 0;

function buildGameWsUrl(gid) {
    const origin = window.API_ORIGIN || window.location.origin;
    const url = new URL(origin, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `/api/poker/games/${gid}/ws`;
    return url.toString();
}

function connectGameWs(gid) {
    if (!gid || !('WebSocket' in window)) return;
    if (gameWs) { try { gameWs.close(); } catch {} gameWs = null; }
    if (Date.now() < gameWsBackoffUntil) return;
    try {
        const ws = new WebSocket(buildGameWsUrl(gid));
        gameWs = ws;
        ws.onopen = () => {
            gameWsReconnectAttempts = 0;
            ws.send(JSON.stringify({ player_id: playerId, player_token: playerToken }));
        };
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (!msg) return;
                if (msg.type === 'state_changed' || msg.type === 'hello') {
                    pollOnceNow();
                }
            } catch { /* ignore malformed frames */ }
        };
        ws.onerror = () => { /* will surface in onclose */ };
        ws.onclose = () => {
            gameWs = null;
            if (gameId !== gid) return; // moved on, don't reconnect
            gameWsReconnectAttempts += 1;
            // Cap reconnect attempts and back off; polling keeps state fresh.
            if (gameWsReconnectAttempts > 5) {
                gameWsBackoffUntil = Date.now() + 60_000;
                return;
            }
            const delayMs = Math.min(30_000, 1000 * Math.pow(2, gameWsReconnectAttempts));
            gameWsReconnectTimer = setTimeout(() => connectGameWs(gid), delayMs);
        };
    } catch {
        // Backoff briefly so we don't tight-loop on misconfig
        gameWsBackoffUntil = Date.now() + 30_000;
    }
}

function disconnectGameWs() {
    if (gameWsReconnectTimer) { clearTimeout(gameWsReconnectTimer); gameWsReconnectTimer = null; }
    if (gameWs) { try { gameWs.close(); } catch {} gameWs = null; }
    gameWsReconnectAttempts = 0;
    gameWsBackoffUntil = 0;
}

// Triggered by WS ping. Runs one off-cycle fetch immediately. Polling continues
// in parallel so a missed ping never leaves state stale for long.
let pollOnceInFlight = false;
async function pollOnceNow() {
    if (pollOnceInFlight) return;
    if (!gameId || !playerId) return;
    pollOnceInFlight = true;
    try {
        const url = gameRequestUrl(`/games/${gameId}`, { process_ai: gameState?.game_type === 'multiplayer' ? 'false' : 'true' });
        const response = await APIRequest.fetch(url, { headers: playerAuthHeaders() });
        if (!response.ok) return;
        const data = await response.json();
        gameState = data;
        updateGameDisplay();
    } catch { /* polling cycle will catch the next update */ }
    finally { pollOnceInFlight = false; }
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
        amount = getRaiseSizeForRequest(raiseAmount);
    }
    
    isRequestPending = true;
    
    try {
        const body = { player_id: playerId, player_token: playerToken, action };
        if (amount !== null) body.amount = amount;
        
        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games/${gameId}/action`, {
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

function getRaiseSizeForRequest(totalCommitment) {
    const myPlayer = gameState?.players?.find(p => p.id === playerId);
    return calculateRaiseSizeForRequest(totalCommitment, gameState?.current_bet, myPlayer?.bet);
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
    const yourSection = document.querySelector('.your-section');
    yourSection?.classList.add('raise-open');
    requestAnimationFrame(() => {
        if (yourSection) {
            yourSection.scrollTop = yourSection.scrollHeight;
        }
    });
}

function hideRaiseControls() {
    elements.raiseContainer.classList.add('hidden');
    elements.actionButtons.classList.remove('hidden');
    document.querySelector('.your-section')?.classList.remove('raise-open');
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

function getShowdownHandKey() {
    return `${gameId || 'local'}:${gameState?.hand_number || 'unknown'}`;
}

function dismissShowdownPopup() {
    if (!elements.showdownPanel || elements.showdownPanel.classList.contains('hidden')) return;

    dismissedShowdownHand = getShowdownHandKey();
    elements.showdownPanel.classList.add('showdown-dismissed');
    elements.showdownPanel.classList.remove('showdown-animate');
    elements.btnNextHand?.focus({ preventScroll: true });
}

async function nextHand() {
    // Prevent race condition
    if (isRequestPending) {
        console.log('Next hand ignored - request already in progress');
        return;
    }

    isRequestPending = true;

    // Clear seen cards for a new hand so card deal animations can replay.
    seenCards.clear();

    try {
        elements.btnNextHand.disabled = true;
        showLoading('Dealing…');

        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games/${gameId}/next-hand`, {
            method: 'POST',
            body: JSON.stringify({ player_id: playerId, player_token: playerToken })
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
        elements.btnNextHand.textContent = 'Next hand';
    }
}

function renderTournamentBanner(state) {
    const banner = document.getElementById('tournament-banner');
    if (!banner) return;
    const t = state && state.tournament;
    if (!t || state.game_type !== 'tournament') {
        banner.hidden = true;
        return;
    }
    banner.hidden = false;
    const levelEl = document.getElementById('tb-level');
    const blindsEl = document.getElementById('tb-blinds');
    const nextEl = document.getElementById('tb-next');
    const aliveEl = document.getElementById('tb-alive');
    if (levelEl) levelEl.textContent = t.level;
    if (blindsEl) blindsEl.textContent = `${state.small_blind} / ${state.big_blind}`;
    if (nextEl) nextEl.textContent = t.next_level_in;
    const alive = (state.players || []).filter((p) => p.chips > 0).length;
    if (aliveEl) aliveEl.textContent = alive;
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
        dismissedShowdownHand = null;
    }

    // Update the table HUD
    elements.handNumber.textContent = gameState.hand_number;
    const phase = PHASES[gameState.phase] || { label: gameState.phase, tip: '' };
    elements.phase.textContent = phase.label;
    elements.phase.dataset.tip = phase.tip;
    elements.potAmount.textContent = formatChips(gameState.pot);
    if (elements.hudBlinds && gameState.small_blind) {
        elements.hudBlinds.textContent = `${formatChips(gameState.small_blind)} / ${formatChips(gameState.big_blind)}`;
    }
    renderTournamentBanner(gameState);
    elements.gameScreen?.classList.toggle('showdown-active', isShowdown);
    if (!isShowdown) {
        hideHandResult();
    }
    
    // Check if it's your turn
    const isYourTurn = gameState.current_player === playerId && !isShowdown;
    
    // Update your info
    const myPlayer = gameState.players.find(p => p.id === playerId);
    if (myPlayer) {
        elements.yourChips.textContent = formatChips(myPlayer.chips);
        window.pokerCasinoHeader?.setChips(myPlayer.chips);
        if (elements.yourPositionChip) {
            elements.yourPositionChip.innerHTML = renderPositionChip(myPlayer);
        }

        // Your cards with staggered animation (deal player cards first)
        const cardsHTML = myPlayer.hand.map((card, index) => renderCard(card, index)).join('');
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
        <div class="card-slot" id="flop-1">${community[0] ? renderCard(community[0], 2) : ''}</div>
        <div class="card-slot" id="flop-2">${community[1] ? renderCard(community[1], 3) : ''}</div>
        <div class="card-slot" id="flop-3">${community[2] ? renderCard(community[2], 4) : ''}</div>
        <div class="card-slot" id="turn">${community[3] ? renderCard(community[3], 2) : ''}</div>
        <div class="card-slot" id="river">${community[4] ? renderCard(community[4], 2) : ''}</div>
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

// Build the dealer button / blind chip for a seat. The dealer button is the
// primary indicator of turn order; in heads-up the dealer also posts the small
// blind, so dealer takes priority over the blind chips.
function renderPositionChip(player) {
    if (player.is_dealer) {
        return `<span class="position-chip dealer" data-tip="Dealer button — acts last after the flop" aria-label="Dealer">D</span>`;
    }
    if (player.is_small_blind) {
        return `<span class="position-chip small-blind" data-tip="Small blind — posts ${gameState?.small_blind ?? ''} before the deal" aria-label="Small blind">SB</span>`;
    }
    if (player.is_big_blind) {
        return `<span class="position-chip big-blind" data-tip="Big blind — posts ${gameState?.big_blind ?? ''} before the deal" aria-label="Big blind">BB</span>`;
    }
    return '';
}

// A HUD-style tag for each bot's style. Two or three letters on the table,
// the full explanation on hover.
const PERSONALITY_TAGS = {
    tag: { tag: 'TAG', tip: 'Tight-aggressive — plays few hands, bets them hard' },
    lp: { tag: 'LP', tip: 'Loose-passive — calls far too much, rarely raises' },
    mn: { tag: 'MAN', tip: 'Maniac — bets and bluffs relentlessly, high variance' },
    std: { tag: 'STD', tip: 'Standard — balanced, by-the-book ranges' },
    rock: { tag: 'ROC', tip: 'Rock — folds anything marginal, only bets the nuts' }
};

function renderPersonalityTag(player) {
    const preset = PERSONALITY_TAGS[player.ai_personality];
    if (!preset) return '';
    const tip = player.ai_personality_label
        ? preset.tip
        : `${preset.tag} playing style`;
    return `<span class="seat-style" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(player.ai_personality_label || preset.tag)}">${preset.tag}</span>`;
}

function renderOpponent(player, seatClass = 'seat-1') {
    const isCurrent = gameState.phase !== 'showdown' && gameState.current_player === player.id;
    const isShowdown = gameState.phase === 'showdown';
    const showCards = isShowdown && !player.folded;
    const isWinner = gameState.winners?.some(w => w.id === player.id);
    const recentAIAction = gameState.last_ai_action?.player_name === player.name ? gameState.last_ai_action : null;
    const actionLabel = recentAIAction ? formatActionLabel(recentAIAction) : '';
    const classes = [
        'seat',
        seatClass,
        player.folded ? 'is-folded' : '',
        isCurrent ? 'is-active' : '',
        isWinner ? 'is-winner' : ''
    ].filter(Boolean).join(' ');

    const cards = showCards
        ? player.hand.map(c => renderCard(c)).join('')
        : isShowdown
            ? ''
            : '<div class="card-back"></div><div class="card-back"></div>';

    return `
        <div class="${classes}">
            <div class="seat-cards">${cards}</div>
            <div class="seat-plate">
                ${renderPositionChip(player)}
                <span class="seat-name"><span class="seat-nick">${escapeHtml(player.name)}</span>${renderPersonalityTag(player)}</span>
                <span class="seat-stack" data-tip="Chips behind">${formatChips(player.chips)}</span>
                ${player.bet > 0 ? `<span class="seat-bet" data-tip="Bet this round">${formatChips(player.bet)}</span>` : ''}
                ${actionLabel ? `<span class="seat-action">${escapeHtml(actionLabel)}</span>` : ''}
            </div>
        </div>
    `;
}

function formatActionLabel(action) {
    if (!action) return '';
    const label = String(action.action || '').replace('-', ' ');
    const pretty = label.charAt(0).toUpperCase() + label.slice(1);
    return action.amount ? `${pretty} ${formatChips(action.amount)}` : pretty;
}

function renderCard(card, dealIndex = null) {
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
    
    return `<div class="card ${animationClass} ${isRed ? 'red' : 'black'}" aria-label="${rank} of ${card.suit.toLowerCase()}">
        <span class="card-corner" aria-hidden="true">${rank}</span>
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${suitSymbol}</span>
    </div>`;
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
            .filter(([, c]) => c === n)
            .map(([r]) => parseInt(r))
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
            .filter(([, c]) => c === n)
            .map(([r]) => parseInt(r))
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

// The action row stays on screen the whole hand and simply goes inert when
// it is someone else's turn — an empty dock reads as a broken UI, and a
// row that appears and disappears makes the layout jump.
function setActionsIdle(idle, waitingOn = '') {
    elements.actionButtons.classList.toggle('is-idle', idle);
    [elements.btnFold, elements.btnCall, elements.btnRaise].forEach((btn) => {
        if (btn) btn.disabled = idle;
    });
    if (idle) {
        elements.actionButtons.dataset.tip = waitingOn ? `Waiting on ${waitingOn}` : 'Not your turn';
    } else {
        delete elements.actionButtons.dataset.tip;
    }
}

function updateActionButtons() {
    if (!gameState || gameState.phase === 'showdown') {
        elements.raiseContainer.classList.add('hidden');
        elements.actionButtons.classList.remove('hidden');
        setActionsIdle(true);
        document.querySelector('.your-section')?.classList.remove('raise-open');
        return;
    }

    const myPlayer = gameState.players.find(p => p.id === playerId);
    isMyTurn = gameState.current_player === playerId;

    if (!isMyTurn || !myPlayer) {
        elements.raiseContainer.classList.add('hidden');
        elements.actionButtons.classList.remove('hidden');
        const waitingOn = gameState.players.find(p => p.id === gameState.current_player)?.name || '';
        setActionsIdle(true, waitingOn);
        document.querySelector('.your-section')?.classList.remove('raise-open');
        return;
    }

    if (!elements.raiseContainer.classList.contains('hidden')) {
        elements.actionButtons.classList.add('hidden');
        document.querySelector('.your-section')?.classList.add('raise-open');
        return;
    }

    elements.actionButtons.classList.remove('hidden');
    setActionsIdle(false);

    const toCall = gameState.current_bet - myPlayer.bet;

    if (toCall === 0) {
        elements.btnCall.textContent = 'Check';
        elements.btnCall.setAttribute('aria-label', 'Check (C)');
        elements.btnCall.dataset.tip = 'Stay in the hand without betting (C)';
    } else {
        const callAmount = Math.min(toCall, myPlayer.chips);
        const label = myPlayer.chips <= toCall ? 'All in' : `Call ${formatChips(callAmount)}`;
        elements.btnCall.textContent = label;
        elements.btnCall.setAttribute('aria-label', `${label} (C)`);
        // Pot odds are the one number that makes a call obviously right or
        // obviously wrong, so it goes in the tooltip rather than on screen.
        const potAfterCall = (gameState.pot || 0) + callAmount;
        const breakEven = Math.round((callAmount / (potAfterCall + callAmount)) * 100);
        elements.btnCall.dataset.tip = `Pay ${formatChips(callAmount)} to play for ${formatChips(potAfterCall)} — break even at ${breakEven}% (C)`;
    }
    elements.btnFold.setAttribute('aria-label', 'Fold (F)');
    elements.btnRaise.setAttribute('aria-label', 'Raise (R)');

    // Too short to make a legal raise: leave the button in place, disabled,
    // so the row keeps its shape and the tooltip says why.
    const minRaise = gameState.min_raise || 20;
    const canRaise = myPlayer.chips > toCall + minRaise;
    elements.btnRaise.disabled = !canRaise;
    elements.btnRaise.dataset.tip = canRaise
        ? 'Bet more and put the table to a decision (R)'
        : `Not enough chips to raise — a legal raise needs ${formatChips(toCall + minRaise)}`;
}

function showHandResult() {
    if (!gameState.winners || gameState.winners.length === 0) return;

    // Update display one more time to show all cards
    updateGameDisplay();

    const winner = gameState.winners[0];
    const myWin = gameState.winners.find(w => w.id === playerId);
    const isMe = Boolean(myWin);
    const isChop = Boolean(myWin && gameState.winners.length > 1);
    const myPlayer = gameState.players.find(p => p.id === playerId);
    const isBusted = Boolean(myPlayer && myPlayer.chips <= 0);

    // Record stats for hand result (only once per hand)
    if (!handResultRecorded) {
        handResultRecorded = true;
        const handStrengthEl = elements.handStrength?.querySelector('.hand-strength-text');
        const handName = handStrengthEl ? handStrengthEl.textContent : null;
        const holeCards = (myPlayer && myPlayer.hole_cards) || (myPlayer && myPlayer.cards) || null;
        const board = gameState.community_cards || gameState.board || null;
        if (isMe) {
            const amountContributed = (myPlayer && (myPlayer.total_bet || myPlayer.bet)) || 0;
            const netWin = myWin.amount - amountContributed;
            StatsManager.recordHandWin(myWin.amount, handName);
            StatsManager.recordHand({
                result: isChop ? 'chop' : 'win',
                amount: myWin.amount,
                handName,
                holeCards,
                board
            });
            window.CasinoProfile?.recordSession('poker', {
                handsPlayed: 1, netProfit: netWin, biggestWin: Math.max(0, netWin)
            });
        } else if (myPlayer) {
            const amountLost = myPlayer.total_bet || myPlayer.bet || 0;
            StatsManager.recordHandLoss(amountLost);
            StatsManager.recordHand({
                result: 'loss',
                amount: -amountLost,
                handName,
                holeCards,
                board
            });
            window.CasinoProfile?.recordSession('poker', {
                handsPlayed: 1, netProfit: -amountLost
            });
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
    const outcomeClass = isMe ? (isChop ? 'showdown-chop' : 'showdown-win') : 'showdown-loss';
    const outcomeLabel = isMe ? (isChop ? 'CHOP' : 'WIN') : 'LOSS';
    const isDismissed = dismissedShowdownHand === getShowdownHandKey();

    elements.showdownTitle.textContent = isMe ? (isChop ? 'Chop' : 'You win') : 'You lose';
    elements.showdownDetails.textContent = [
        winnerNames,
        handName || 'best hand',
        `+${formatChips(totalWon)}`
    ].join(' · ');
    elements.btnNextHand.textContent = isBusted ? 'Buy back in' : 'Next hand';
    elements.btnNextHand.disabled = false;
    elements.showdownPanel.classList.remove('showdown-win', 'showdown-loss', 'showdown-chop', 'showdown-animate', 'showdown-dismissed');
    elements.showdownPanel.classList.add(outcomeClass);
    elements.showdownPanel.classList.toggle('showdown-dismissed', isDismissed);
    elements.showdownPanel.dataset.outcomeLabel = outcomeLabel;
    if (!isDismissed) {
        void elements.showdownPanel.offsetWidth;
        elements.showdownPanel.classList.add('showdown-animate');
    }
    elements.showdownPanel.classList.remove('hidden');
}

function hideHandResult() {
    elements.showdownPanel?.classList.add('hidden');
    elements.showdownPanel?.classList.remove('showdown-win', 'showdown-loss', 'showdown-chop', 'showdown-animate', 'showdown-dismissed');
    dismissedShowdownHand = null;
    if (elements.showdownPanel) {
        delete elements.showdownPanel.dataset.outcomeLabel;
    }
}

async function buyBackIn() {
    if (isRequestPending || !gameId || !playerId) return;

    isRequestPending = true;
    try {
        const response = await APIRequest.fetch(`${API_BASE}/api/poker/games/${gameId}/buy-back`, {
            method: 'POST',
            body: JSON.stringify({ player_id: playerId, player_token: playerToken })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || err.message || 'Buy-back failed');
        }

        const responseData = await response.json();
        updateGameState(responseData);
        updateGameDisplay();
        showHandResult();
    } catch (error) {
        console.error('Buy-back failed:', error);
        ErrorBoundary.show(error.message || 'Buy-back failed. Please try again.', 'error');
    } finally {
        isRequestPending = false;
    }
}

function showStats() {
    const stats = StatsManager.getFormattedStats();
    const netProfitClass = stats.netProfit >= 0 ? 'positive' : 'negative';
    const historyHtml = renderHandHistory(StatsManager.history || []);

    elements.statsContent.innerHTML = `
        <div class="stat-row">
            <span class="stat-label" data-tip="Hands you have been dealt in" data-tip-pos="right">Hands</span>
            <span class="stat-value">${formatChips(stats.handsPlayed)}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label" data-tip="Hands where you took at least part of the pot" data-tip-pos="right">Won</span>
            <span class="stat-value">${formatChips(stats.handsWon)}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label" data-tip="Share of hands you won" data-tip-pos="right">Win rate</span>
            <span class="stat-value">${stats.winRate}%</span>
        </div>
        <div class="stat-row">
            <span class="stat-label" data-tip="Largest single pot you have taken down" data-tip-pos="right">Biggest pot</span>
            <span class="stat-value">${formatChips(stats.biggestPotWon)}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label" data-tip="Chips won minus chips lost, all time" data-tip-pos="right">Net</span>
            <span class="stat-value ${netProfitClass}">${stats.netProfit >= 0 ? '+' : ''}${formatChips(stats.netProfit)}</span>
        </div>
        <div class="stat-row">
            <span class="stat-label" data-tip="Strongest holding you have made at showdown" data-tip-pos="right">Best hand</span>
            <span class="stat-value">${escapeHtml(stats.bestHand)}</span>
        </div>
        ${historyHtml}
    `;
    const clearBtn = elements.statsContent.querySelector('#clearHistoryBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (!window.confirm('Clear hand history?')) return;
            StatsManager.clearHistory();
            showStats();
        });
    }
    elements.statsModal.classList.remove('hidden');
}

function formatHistoryCard(card) {
    if (!card) return '·';
    if (typeof card === 'string') return card;
    if (typeof card === 'object') {
        // The API sends numeric ranks and upper-case suit names; older stored
        // history may use single letters.
        const raw = card.rank ?? card.value ?? card.r ?? '?';
        const rank = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J' }[raw] ?? String(raw);
        const suit = String(card.suit || card.s || '').toLowerCase();
        const suitSym = { hearts: '♥', diamonds: '♦', spades: '♠', clubs: '♣', h: '♥', d: '♦', s: '♠', c: '♣' };
        return `${rank}${suitSym[suit] || ''}`;
    }
    return String(card);
}

function renderHandHistory(history) {
    if (!history || history.length === 0) {
        return '<div class="hand-history-empty">No hands yet.</div>';
    }
    const rows = history.slice(0, 20).map((h) => {
        const result = h.result === 'win' ? 'Win' : h.result === 'chop' ? 'Chop' : 'Loss';
        const amt = (h.amount > 0 ? '+' : '') + (h.amount || 0);
        const cls = h.amount > 0 ? 'positive' : h.amount < 0 ? 'negative' : '';
        const hole = (h.holeCards || []).map(formatHistoryCard).join(' ');
        const board = (h.board || []).map(formatHistoryCard).join(' ');
        const when = h.ts ? new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return `
            <li class="hand-history-row">
                <span class="hh-result hh-${h.result}">${result}</span>
                <span class="hh-cards">${escapeHtml(hole) || '—'}<span class="hh-board"> · ${escapeHtml(board) || '—'}</span></span>
                <span class="hh-amt ${cls}">${escapeHtml(String(amt))}</span>
                <span class="hh-when">${escapeHtml(when)}</span>
            </li>
        `;
    }).join('');
    return `
        <div class="hand-history">
            <div class="hand-history-head">
                <h4>Last ${history.length} hands</h4>
                <button type="button" id="clearHistoryBtn" class="hh-clear">Clear</button>
            </div>
            <ul class="hand-history-list">${rows}</ul>
        </div>
    `;
}

function hideStats() {
    elements.statsModal.classList.add('hidden');
}

function switchScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');
    document.body.classList.toggle('poker-game-active', screenName === 'game');

    if (screenName === 'game') {
        // Initialize gesture manager when entering game screen
        GestureManager.init();
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
            elements.timerText.textContent = 'Time up — folding';
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
    
    elements.timerText.textContent = `Your turn — ${seconds}s left`;
    elements.timerFill.style.width = `${percentage}%`;

    // Add urgency styling when time is low
    const urgent = seconds <= 5;
    elements.timerText.classList.toggle('urgent', urgent);
    elements.decisionTimer?.classList.toggle('urgent', urgent);
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

// Keyboard shortcuts for poker actions
// F = fold, C = check/call, R = raise (open controls or confirm), Escape = cancel raise
document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'SELECT') return;
    if (!gameId || !playerId) return;

    const raiseOpen = elements.raiseContainer && !elements.raiseContainer.classList.contains('hidden');

    switch (event.key.toLowerCase()) {
        case 'f':
            if (isMyTurn) playerAction('fold');
            break;
        case 'c':
            if (isMyTurn && !raiseOpen) {
                const myPlayer = gameState?.players?.find(p => p.id === playerId);
                const toCall = (gameState?.current_bet || 0) - (myPlayer?.bet || 0);
                playerAction(toCall > 0 ? 'call' : 'check');
            }
            break;
        case 'r':
            if (isMyTurn) {
                if (raiseOpen) {
                    confirmRaise();
                } else {
                    showRaiseControls();
                }
            }
            break;
        case 'escape':
            if (raiseOpen) hideRaiseControls();
            break;
    }
});
