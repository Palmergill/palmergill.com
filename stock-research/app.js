// API_BASE = `${API_ORIGIN}/api`. See /shared/api-base.js for overrides.
const API_BASE = ((typeof window !== 'undefined' && typeof window.API_ORIGIN === 'string')
    ? window.API_ORIGIN
    : '') + '/api';

let currentTicker = '';

// Helper functions (defined globally for use in displayResults)
function formatMarketCap(value) {
    if (!value) return 'N/A';
    if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
    if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
    return `$${value.toLocaleString()}`;
}

function formatPercent(value) {
    if (value === null || value === undefined) return 'N/A';
    return `${value.toFixed(2)}%`;
}

function formatNumber(value, decimals = 2) {
    if (value === null || value === undefined) return 'N/A';
    return value.toFixed(decimals);
}

// Store previous values for flash animation
const previousValues = {};

// Helper to update value with flash animation
function updateValueWithFlash(elementId, newValue, formatter = (v) => v) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const oldValue = previousValues[elementId];
    const formattedNew = formatter(newValue);
    
    // Skip if first load or no change
    if (oldValue === undefined || oldValue === formattedNew) {
        element.textContent = formattedNew;
        previousValues[elementId] = formattedNew;
        return;
    }
    
    // Determine direction for color flash
    const oldNum = parseFloat(oldValue.toString().replace(/[^0-9.-]/g, ''));
    const newNum = parseFloat(formattedNew.toString().replace(/[^0-9.-]/g, ''));
    
    element.classList.remove('flash-up', 'flash-down');
    void element.offsetWidth; // Trigger reflow
    
    if (!isNaN(oldNum) && !isNaN(newNum)) {
        if (newNum > oldNum) {
            element.classList.add('flash-up');
        } else if (newNum < oldNum) {
            element.classList.add('flash-down');
        }
    }
    
    element.textContent = formattedNew;
    previousValues[elementId] = formattedNew;
    
    // Remove animation class after animation completes
    setTimeout(() => {
        element.classList.remove('flash-up', 'flash-down');
    }, 800);
}

// Calculate trends from earnings data and update metric indicators
function calculateAndDisplayTrends(earnings) {
    if (!earnings || earnings.length < 2) return;
    
    // Sort by date (oldest first)
    const sorted = [...earnings].sort((a, b) => new Date(a.fiscal_date) - new Date(b.fiscal_date));
    const recent = sorted.slice(-4); // Last 4 quarters
    const older = sorted.slice(-8, -4); // 4 quarters before that
    
    if (recent.length < 2) return;
    
    // Calculate revenue trend
    const recentRevenue = recent.reduce((sum, e) => sum + (e.revenue || 0), 0) / recent.length;
    const olderRevenue = older.length > 0 ? older.reduce((sum, e) => sum + (e.revenue || 0), 0) / older.length : recentRevenue;
    const revenueTrend = recentRevenue > olderRevenue * 1.05 ? 'up' : recentRevenue < olderRevenue * 0.95 ? 'down' : 'neutral';
    updateMetricTrend('revenueGrowth', revenueTrend);
    
    // Calculate EPS trend
    const recentEPS = recent.reduce((sum, e) => sum + (e.reported_eps || 0), 0) / recent.length;
    const olderEPS = older.length > 0 ? older.reduce((sum, e) => sum + (e.reported_eps || 0), 0) / older.length : recentEPS;
    const epsTrend = recentEPS > olderEPS * 1.1 ? 'up' : recentEPS < olderEPS * 0.9 ? 'down' : 'neutral';
    updateMetricTrend('peRatio', epsTrend); // P/E trend based on EPS direction
    
    // Calculate FCF trend (if available)
    const recentFCF = recent.reduce((sum, e) => sum + (e.free_cash_flow || 0), 0) / recent.length;
    const olderFCF = older.length > 0 ? older.reduce((sum, e) => sum + (e.free_cash_flow || 0), 0) / older.length : recentFCF;
    const fcfTrend = recentFCF > olderFCF * 1.1 ? 'up' : recentFCF < olderFCF * 0.9 ? 'down' : 'neutral';
    updateMetricTrend('freeCashFlow', fcfTrend);
}

function updateMetricTrend(elementId, trend) {
    const element = document.getElementById(elementId);
    if (!element) return;
    const metricCard = element.closest('.metric');
    if (metricCard) {
        metricCard.dataset.trend = trend;
    }
}

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    
    // Add ripple effect to all buttons
    function createRipple(event) {
        const button = event.currentTarget instanceof HTMLButtonElement
            ? event.currentTarget
            : event.target.closest('button');
        if (!button) return;
        const circle = document.createElement('span');
        const diameter = Math.max(button.clientWidth, button.clientHeight);
        const radius = diameter / 2;
        
        circle.style.width = circle.style.height = `${diameter}px`;
        circle.style.left = `${event.clientX - button.getBoundingClientRect().left - radius}px`;
        circle.style.top = `${event.clientY - button.getBoundingClientRect().top - radius}px`;
        circle.classList.add('ripple');
        
        const existingRipple = button.getElementsByClassName('ripple')[0];
        if (existingRipple) {
            existingRipple.remove();
        }
        
        button.appendChild(circle);
        
        setTimeout(() => circle.remove(), 600);
    }
    
    // Delegate from the document root so re-rendered buttons (filter,
    // search) don't accumulate fresh listeners each time, which leaked
    // memory and fired the ripple callback multiple times per click.
    document.addEventListener('click', createRipple);
    
    // Magnetic button effect for primary buttons. Excludes .site-nav
    // (shared header/hamburger) so its buttons don't visibly shift under
    // the cursor — that chrome isn't owned by this page.
    function initMagneticButtons() {
        const magneticButtons = [...document.querySelectorAll('button')]
            .filter((button) => !button.closest('.site-nav'));
        
        magneticButtons.forEach(button => {
            button.classList.add('magnetic');
            
            button.addEventListener('mousemove', (e) => {
                const rect = button.getBoundingClientRect();
                const x = e.clientX - rect.left - rect.width / 2;
                const y = e.clientY - rect.top - rect.height / 2;
                
                // Magnetic pull strength (max 8px movement)
                const strength = 0.3;
                const maxMove = 8;
                
                const moveX = Math.max(-maxMove, Math.min(maxMove, x * strength));
                const moveY = Math.max(-maxMove, Math.min(maxMove, y * strength));
                
                button.style.transform = `translate(${moveX}px, ${moveY}px)`;
            });
            
            button.addEventListener('mouseleave', () => {
                button.style.transform = '';
            });
        });
    }
    
    initMagneticButtons();
    
    // Initialize custom metric tooltips
    function initMetricTooltips() {
        const tooltip = document.getElementById('metricTooltip');
        if (!tooltip) return;
        
        const titleEl = tooltip.querySelector('.tooltip-title');
        const descEl = tooltip.querySelector('.tooltip-description');
        
        // Find all metric cards with title attributes
        document.querySelectorAll('.metric[title]').forEach(metric => {
            const titleText = metric.getAttribute('title');
            if (!titleText) return;
            
            // Extract label as title and rest as description
            const labelEl = metric.querySelector('.metric-label');
            const label = labelEl ? labelEl.textContent : 'Metric';
            
            // Remove default title to prevent browser tooltip
            metric.removeAttribute('title');
            metric.dataset.tooltipTitle = label;
            metric.dataset.tooltipDesc = titleText;
            
            metric.addEventListener('mouseenter', (e) => {
                titleEl.textContent = label;
                descEl.textContent = titleText;
                tooltip.classList.remove('hidden');
                
                // Position tooltip
                positionTooltip(e, tooltip, metric);
            });
            
            metric.addEventListener('mousemove', (e) => {
                positionTooltip(e, tooltip, metric);
            });
            
            metric.addEventListener('mouseleave', () => {
                tooltip.classList.add('hidden');
            });
        });
        
        function positionTooltip(e, tooltip, metric) {
            const rect = metric.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            
            // Position above the metric by default
            let top = rect.top - tooltipRect.height - 12;
            let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            
            // Adjust if going off screen
            if (top < 10) {
                top = rect.bottom + 12; // Show below if not enough space above
            }
            if (left < 10) {
                left = 10;
            } else if (left + tooltipRect.width > window.innerWidth - 10) {
                left = window.innerWidth - tooltipRect.width - 10;
            }
            
            tooltip.style.top = `${top}px`;
            tooltip.style.left = `${left}px`;
        }
    }
    
    // Run after a short delay to ensure DOM is ready
    setTimeout(initMetricTooltips, 100);
    
    // DOM elements
    const searchForm = document.getElementById('searchForm');
    const tickerInput = document.getElementById('tickerInput');
    const searchBtn = document.getElementById('searchBtn');
    const searchSuggestions = document.getElementById('searchSuggestions');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');
    const errorMessage = document.getElementById('errorMessage');
    const retryBtn = document.getElementById('retryBtn');
    const empty = document.getElementById('empty');
    const results = document.getElementById('results');
    const searchModal = document.getElementById('searchModal');
    const searchIconBtnMain = document.getElementById('searchIconBtnMain');
    const searchIconBtnInline = document.getElementById('searchIconBtnInline');
    const closeSearchModal = document.getElementById('closeSearchModal');
    const demoBanner = document.getElementById('demoBanner');

    function setDemoMode(isDemo, warning) {
        if (!demoBanner) return;
        if (isDemo) {
            demoBanner.textContent = warning || 'Public demo mode uses generated sample stock data. Live market provider calls stay protected.';
            demoBanner.classList.remove('hidden');
        } else {
            demoBanner.classList.add('hidden');
        }
    }
    
    // Search Modal Functions
    function openSearchModal() {
        if (searchModal) {
            searchModal.classList.remove('hidden');
            tickerInput.focus();
        }
    }
    
    function closeSearchModalFn() {
        if (searchModal) {
            searchModal.classList.add('hidden');
            searchSuggestions.classList.add('hidden');
            tickerInput.value = '';
        }
    }
    
    if (searchIconBtnMain) {
        searchIconBtnMain.addEventListener('click', openSearchModal);
    }
    
    if (searchIconBtnInline) {
        searchIconBtnInline.addEventListener('click', openSearchModal);
    }
    
    if (closeSearchModal) {
        closeSearchModal.addEventListener('click', closeSearchModalFn);
    }
    
    if (searchModal) {
        searchModal.addEventListener('click', (e) => {
            if (e.target === searchModal || e.target.classList.contains('search-modal-backdrop')) {
                closeSearchModalFn();
            }
        });
    }
    
    // ESC key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchModal && !searchModal.classList.contains('hidden')) {
            closeSearchModalFn();
        }
    });
    
    // Verify critical elements exist
    if (!searchForm || !tickerInput || !searchBtn) {
        console.error('Missing elements:', { searchForm, tickerInput, searchBtn });
        return;
    }
    
    // Initialize trending stock buttons
    function initTrendingStocks() {
        document.querySelectorAll('.trending-stock').forEach(btn => {
            btn.addEventListener('click', () => {
                const ticker = btn.dataset.ticker;
                if (ticker) {
                    tickerInput.value = ticker;
                    loadStock(ticker);
                }
            });
        });
    }
    
    initTrendingStocks();

    // Autocomplete functionality
    let searchTimeout = null;
    let selectedSuggestionIndex = -1;
    let currentSuggestions = [];
    let currentRetryInterval = null;
    let lastChartData = null;
    let lastPriceHistory = null;
    let sharesOutstanding = 1;

    async function fetchSuggestions(query) {
        if (!query || query.length < 1) {
            searchSuggestions.classList.remove('visible');
            setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/stocks/search?q=${encodeURIComponent(query)}&limit=10`, {
                credentials: 'include',
            });
            if (response.ok) {
                const data = await response.json();
                currentSuggestions = data.results || [];
                renderSuggestions(currentSuggestions);
            }
        } catch (err) {
            console.error('Error fetching suggestions:', err);
        }
    }

    function renderSuggestions(suggestions) {
        if (suggestions.length === 0) {
            searchSuggestions.classList.remove('visible');
            setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
            return;
        }

        searchSuggestions.replaceChildren(...suggestions.map((item, index) => {
            const suggestion = document.createElement('div');
            suggestion.className = 'suggestion-item';
            suggestion.dataset.ticker = item.ticker || '';
            suggestion.dataset.index = String(index);

            const main = document.createElement('div');
            main.className = 'suggestion-main';

            const ticker = document.createElement('span');
            ticker.className = 'suggestion-ticker';
            ticker.textContent = item.ticker || '';

            const name = document.createElement('span');
            name.className = 'suggestion-name';
            name.textContent = item.name || '';

            const sector = document.createElement('span');
            sector.className = 'suggestion-sector';
            sector.textContent = item.sector || '';

            main.append(ticker, name);
            suggestion.append(main, sector);
            return suggestion;
        }));

        searchSuggestions.classList.remove('hidden');
        // Trigger animation in next frame
        requestAnimationFrame(() => {
            searchSuggestions.classList.add('visible');
        });
        selectedSuggestionIndex = -1;

        // Add click handlers
        searchSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                const ticker = item.dataset.ticker;
                tickerInput.value = ticker;
                searchSuggestions.classList.remove('visible');
                setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
                closeSearchModalFn();
                loadStock(ticker);
            });
        });
    }

    // Input handling with debounce
    tickerInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            fetchSuggestions(query);
        }, 150);
    });

    // Keyboard navigation
    tickerInput.addEventListener('keydown', (e) => {
        if (currentSuggestions.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, currentSuggestions.length - 1);
            updateSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
            updateSelection();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedSuggestionIndex >= 0 && selectedSuggestionIndex < currentSuggestions.length) {
                const ticker = currentSuggestions[selectedSuggestionIndex].ticker;
                tickerInput.value = ticker;
                searchSuggestions.classList.remove('visible');
                setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
                loadStock(ticker);
            } else {
                const query = tickerInput.value.trim().toUpperCase();
                if (query) {
                    searchSuggestions.classList.remove('visible');
                    setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
                    loadStock(query);
                }
            }
        } else if (e.key === 'Escape') {
            searchSuggestions.classList.remove('visible');
            setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
        }
    });

    function updateSelection() {
        const items = searchSuggestions.querySelectorAll('.suggestion-item');
        items.forEach((item, index) => {
            item.classList.toggle('active', index === selectedSuggestionIndex);
        });
    }

    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!searchForm.contains(e.target)) {
            searchSuggestions.classList.remove('visible');
            setTimeout(() => searchSuggestions.classList.add('hidden'), 200);
        }
    });

    // Note: Refresh button removed - UI streamlined

    // Tab switching
    const tabContents = document.querySelectorAll('.tab-content');
    const headerTabBtns = document.querySelectorAll('.header-tab-btn');
    
    function switchTab(tabId) {
        // Update active states for header tabs
        headerTabBtns.forEach(b => b.classList.remove('active'));
        headerTabBtns.forEach(b => {
            if (b.dataset.tab === tabId) b.classList.add('active');
        });
        
        // Update tab contents
        tabContents.forEach(c => c.classList.remove('active'));
        document.getElementById(tabId).classList.add('active');
        
        // Redraw charts in the active tab (they might not render properly when hidden)
        if (lastChartData) {
            setTimeout(() => {
                const chartData = lastChartData;
                if (tabId === 'overview') {
                    window.StockOverview?.redraw();
                } else if (tabId === 'fundamentals') {
                    window.StockOverview?.redraw();
                    drawRevenueChart(chartData);
                    drawFCFChart(chartData);
                    drawPEChart(chartData, lastPriceHistory);
                }
            }, 10);
        }
    }
    
    headerTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });

    // Search handler
    async function handleSearch(e) {
        if (e) e.preventDefault();
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker) return;
        
        // Close modal and clear input
        closeSearchModalFn();
        
        // Shelby Easter Egg
        if (ticker === 'SHELBY') {
            showShelbyEasterEgg();
            return;
        }
        window.pgAnalytics?.track?.('stock_ticker_searched', { ticker });
        
        // Visual feedback (only if button has spinner elements)
        const btnText = searchBtn?.querySelector?.('.btn-text');
        const btnSpinner = searchBtn?.querySelector?.('.btn-spinner');
        if (btnText) btnText.classList.add('hidden');
        if (btnSpinner) btnSpinner.classList.remove('hidden');
        if (searchBtn) searchBtn.disabled = true;
        
        try {
            await loadStock(ticker);
        } catch (err) {
            console.error('Error loading stock:', err);
        } finally {
            if (btnText) btnText.classList.remove('hidden');
            if (btnSpinner) btnSpinner.classList.add('hidden');
            searchBtn.disabled = false;
        }
    }
    
    searchForm.addEventListener('submit', handleSearch);
    
    // ============================================
    // SHELBY EASTER EGG
    // ============================================
    function showShelbyEasterEgg() {
        const overlay = document.getElementById('shelbyOverlay');
        const canvas = document.getElementById('shelbyCanvas');
        const message = document.getElementById('shelbyMessage');
        const heartsContainer = document.getElementById('shelbyHearts');
        const hint = document.querySelector('.shelby-hint');
        
        if (!overlay || !canvas) return;

        let heartInterval = null;

        // Show overlay
        overlay.classList.remove('hidden');
        setTimeout(() => overlay.classList.add('visible'), 10);
        
        // Setup canvas
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        // Heart drawing animation - positioned below the text
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2 + 80; // Moved down to make room for text
        const size = Math.min(canvas.width, canvas.height) * 0.22; // Slightly smaller
        
        let progress = 0;
        const duration = 3000; // 3 seconds to draw
        const startTime = performance.now();
        let heartsStarted = false;
        
        function drawHeart(p) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw heart path with sparkle
            ctx.beginPath();
            ctx.strokeStyle = '#ff1744';
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#ff1744';
            
            // Heart shape using parametric equations
            const points = [];
            const totalPoints = 200;
            const drawPoints = Math.floor(totalPoints * p);
            
            for (let i = 0; i <= drawPoints; i++) {
                const t = (i / totalPoints) * Math.PI * 2;
                const x = centerX + size * (16 * Math.pow(Math.sin(t), 3)) / 16;
                const y = centerY - size * (13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t)) / 16;
                points.push({x, y});
            }
            
            if (points.length > 1) {
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }
                ctx.stroke();
                
                // Add sparkle at the end
                if (points.length > 5) {
                    const last = points[points.length - 1];
                    ctx.shadowBlur = 30;
                    ctx.fillStyle = '#3b82f6';
                    ctx.beginPath();
                    ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            
            // Add glow effect
            if (p > 0.8) {
                ctx.globalAlpha = (p - 0.8) * 5;
                ctx.fillStyle = '#ff1744';
                ctx.beginPath();
                for (let i = 0; i < points.length; i++) {
                    const t = (i / totalPoints) * Math.PI * 2;
                    const x = centerX + size * 0.9 * (16 * Math.pow(Math.sin(t), 3)) / 16;
                    const y = centerY - size * 0.9 * (13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t)) / 16;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
        
        function animate(currentTime) {
            const elapsed = currentTime - startTime;
            progress = Math.min(elapsed / duration, 1);
            
            drawHeart(progress);
            
            // Start hearts early (at 30% progress)
            if (progress > 0.3 && !heartsStarted) {
                heartsStarted = true;
                startFloatingHearts();
            }
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Show message when heart is complete
                message.classList.add('visible');
                // Show hint
                setTimeout(() => hint.classList.add('visible'), 2000);
            }
        }
        
        requestAnimationFrame(animate);
        
        // Floating hearts
        function startFloatingHearts() {
            const heartEmojis = ['❤️', '💕', '💗', '💖', '💝'];
            
            function createHeart() {
                const heart = document.createElement('div');
                heart.className = 'shelby-heart';
                heart.textContent = heartEmojis[Math.floor(Math.random() * heartEmojis.length)];
                heart.style.left = Math.random() * 100 + '%';
                heart.style.fontSize = (16 + Math.random() * 24) + 'px';
                heart.style.animationDuration = (3 + Math.random() * 3) + 's';
                heart.style.animationDelay = Math.random() * 2 + 's';
                heartsContainer.appendChild(heart);
                
                // Remove after animation
                setTimeout(() => heart.remove(), 7000);
            }
            
            // Create hearts continuously. Keep the id in the closure so the
            // close handler can clear it reliably — storing it on dataset
            // round-trips through a string and parseInt(NaN) silently leaks
            // the interval if the value is lost or replaced.
            heartInterval = setInterval(createHeart, 300);
        }
        
        // Click to close
        function closeOverlay() {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay.classList.add('hidden');
                message.classList.remove('visible');
                hint.classList.remove('visible');
                heartsContainer.innerHTML = '';
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (heartInterval !== null) {
                    clearInterval(heartInterval);
                    heartInterval = null;
                }
            }, 1000);
            overlay.removeEventListener('click', closeOverlay);
            overlay.removeEventListener('touchstart', closeOverlay);
        }
        
        setTimeout(() => {
            overlay.addEventListener('click', closeOverlay);
            overlay.addEventListener('touchstart', closeOverlay);
        }, 4000); // Allow close after animation
    }

    // Retry handler
    retryBtn.addEventListener('click', () => {
        // Clear any running countdown
        if (currentRetryInterval) {
            clearInterval(currentRetryInterval);
            currentRetryInterval = null;
        }
        const retryCountdown = document.getElementById('retryCountdown');
        if (retryCountdown) retryCountdown.classList.add('hidden');
        retryBtn.classList.remove('hidden');
        
        if (currentTicker) {
            loadStock(currentTicker);
        }
    });
    
    // Update loading progress bar
    function updateLoadingProgress(step) {
        const progressFill = document.querySelector('#loadingProgress .progress-fill');
        const steps = document.querySelectorAll('.progress-step');
        
        if (progressFill) {
            const progress = (step / 3) * 100;
            progressFill.style.width = `${progress}%`;
        }
        
        steps.forEach((s, index) => {
            s.classList.remove('active', 'completed');
            if (index + 1 === step) {
                s.classList.add('active');
            } else if (index + 1 < step) {
                s.classList.add('completed');
            }
        });
    }
    
    // Stock tips for loading state
    const stockTips = [
        { icon: '💡', text: 'The P/E ratio helps compare valuations across companies.' },
        { icon: '📈', text: 'Revenue growth shows if a business is expanding over time.' },
        { icon: '💰', text: 'Free Cash Flow is more reliable than net income for analysis.' },
        { icon: '⚖️', text: 'Debt-to-Equity ratio shows financial risk and flexibility.' },
        { icon: '🎯', text: 'ROE above 15% often signals a competitive advantage.' },
        { icon: '📊', text: 'EPS surprises drive stock price movements on earnings day.' },
        { icon: '🔍', text: 'Compare P/E ratios to industry averages for context.' },
        { icon: '📉', text: '52-week range shows where current price sits historically.' }
    ];
    
    let tipInterval = null;
    let currentTipIndex = 0;
    
    function startStockTips() {
        const tipContainer = document.getElementById('stockTip');
        if (!tipContainer) return;
        
        // Clear any existing interval
        if (tipInterval) clearInterval(tipInterval);
        
        currentTipIndex = 0;
        updateTip(tipContainer, 0);
        
        tipInterval = setInterval(() => {
            currentTipIndex = (currentTipIndex + 1) % stockTips.length;
            
            // Fade out
            tipContainer.classList.add('fade-out');
            
            setTimeout(() => {
                updateTip(tipContainer, currentTipIndex);
                tipContainer.classList.remove('fade-out');
            }, 500);
        }, 4000);
    }
    
    function stopStockTips() {
        if (tipInterval) {
            clearInterval(tipInterval);
            tipInterval = null;
        }
    }
    
    function updateTip(container, index) {
        const tip = stockTips[index];
        const iconSpan = container.querySelector('.tip-icon');
        const textSpan = container.querySelector('.tip-text');
        if (iconSpan) iconSpan.textContent = tip.icon;
        if (textSpan) textSpan.textContent = tip.text;
    }

    async function loadStock(ticker, forceRefresh = false, attempt = 1) {
        currentTicker = ticker;
        if (attempt === 1) {
            lastChartData = null;
            lastPriceHistory = null;
            sharesOutstanding = 1;
        }
        
        // Show loading
        loading.classList.remove('hidden');
        error.classList.add('hidden');
        empty.classList.add('hidden');
        results.classList.remove('visible');
        results.classList.add('hidden');
        searchBtn.disabled = true;
        
        // Show loading spinner on button
        const btnSpinner = document.querySelector('#searchBtn .btn-spinner');
        if (btnSpinner) btnSpinner.classList.remove('hidden');
        searchBtn.classList.add('loading');
        
        // Start rotating stock tips
        startStockTips();
        
        // Update progress bar
        updateLoadingProgress(1);
        
        const url = `${API_BASE}/stocks/${encodeURIComponent(ticker)}?refresh=${forceRefresh}`;
        console.log('Fetching URL:', url);
        
        try {
            const response = await fetch(url, {
                credentials: 'include',
            });
            console.log('Response status:', response.status);
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                let errorDetail = errorData.detail || `Server error: ${response.status}`;
                
                // Clean up error message for display
                if (errorDetail.includes('Finnhub') && errorDetail.includes('Yahoo') && errorDetail.includes('Alpha')) {
                    errorDetail = `Unable to fetch data for "${ticker}". All data sources failed. Please check the ticker symbol and try again.`;
                }
                
                throw new Error(errorDetail);
            }
            
            // Update progress - step 1 complete
            updateLoadingProgress(2);
            
            const data = await response.json();
            console.log('Received data:', data);
            setDemoMode(Boolean(data._demo), data._warning);
            
            // Validate data
            if (!data || !data.summary) {
                throw new Error('Invalid data structure received from server');
            }
            
            // Fetch price history
            await fetchPriceHistory(ticker);
            
            // Update progress - step 2 complete
            updateLoadingProgress(3);
            
            displayResults(data);
            window.pgAnalytics?.track?.('stock_ticker_loaded', {
                ticker,
                demo: Boolean(data._demo),
                attempt,
            });
            
        } catch (err) {
            console.error('Error in loadStock fetch:', err);
            loading.classList.add('hidden');
            error.classList.remove('hidden');
            
            // Auto-retry logic (max 3 attempts)
            if (attempt < 3) {
                const retryCountdown = document.getElementById('retryCountdown');
                const countdownSpan = retryCountdown?.querySelector('.countdown-seconds');
                const retryBtn = document.getElementById('retryBtn');
                
                if (retryCountdown && countdownSpan) {
                    retryCountdown.classList.remove('hidden');
                    if (retryBtn) retryBtn.classList.add('hidden');
                    
                    // Show attempt number
                    const attemptText = document.createElement('div');
                    attemptText.className = 'retry-attempt';
                    attemptText.textContent = `Attempt ${attempt} of 3`;
                    attemptText.style.cssText = 'font-size: 12px; color: var(--text-muted); margin-top: 8px;';
                    retryCountdown.appendChild(attemptText);
                    
                    let seconds = 3;
                    countdownSpan.textContent = seconds;
                    
                    const countdownInterval = setInterval(() => {
                        seconds--;
                        countdownSpan.textContent = seconds;
                        
                        if (seconds <= 0) {
                            clearInterval(countdownInterval);
                            retryCountdown.classList.add('hidden');
                            if (retryBtn) retryBtn.classList.remove('hidden');
                            // Remove attempt text
                            const attemptEl = retryCountdown.querySelector('.retry-attempt');
                            if (attemptEl) attemptEl.remove();
                            loadStock(ticker, forceRefresh, attempt + 1);
                        }
                    }, 1000);
                    
                    // Store interval ID so it can be cleared if user clicks retry manually
                    currentRetryInterval = countdownInterval;
                }
            } else {
                window.pgAnalytics?.track?.('stock_ticker_failed', {
                    ticker,
                    message: err.message,
                    attempt,
                });
                // Show final attempt message
                const retryCountdown = document.getElementById('retryCountdown');
                if (retryCountdown) {
                    const failed = document.createElement('span');
                    failed.style.color = 'var(--accent-red)';
                    failed.textContent = 'All retry attempts failed';
                    retryCountdown.replaceChildren(failed);
                    retryCountdown.classList.remove('hidden');
                }
            }
            
            // Show user-friendly error
            let displayError = err.message;
            if (displayError.includes('Failed to fetch')) {
                displayError = 'Network error. Please check your connection and try again.';
            } else if (displayError.includes('404')) {
                displayError = `Stock "${ticker}" not found. Please check the ticker symbol.`;
            }
            
            const label = document.createElement('strong');
            label.textContent = 'Error:';
            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'retry-btn';
            retryButton.textContent = 'Try Again';
            retryButton.addEventListener('click', () => document.getElementById('retryBtn')?.click());
            errorMessage.replaceChildren(label, document.createTextNode(` ${displayError}`), document.createElement('br'), document.createElement('br'), retryButton);
            console.error('Load error:', err);
        } finally {
            if (searchBtn) searchBtn.disabled = false;
            
            // Hide loading spinner
            const btnSpinner = document.querySelector('#searchBtn .btn-spinner');
            if (btnSpinner) btnSpinner.classList.add('hidden');
            if (searchBtn) searchBtn.classList.remove('loading');
            
            // Stop stock tips
            stopStockTips();
        }
    }

    function displayResults(data) {
        // Validate data structure
        if (!data || !data.summary) {
            console.error('Invalid data structure:', data);
            loading.classList.add('hidden');
            error.classList.remove('hidden');
            errorMessage.textContent = 'Invalid data received from server. Please try again.';
            return;
        }
        
        setDemoMode(Boolean(data._demo), data._warning);

        // Update header to show stock info instead of logo
        const headerLogo = document.getElementById('headerLogo');
        const headerStockContent = document.getElementById('headerStockContent');
        const searchIconBtnMain = document.getElementById('searchIconBtnMain');
        if (headerLogo) headerLogo.classList.add('hidden');
        if (headerStockContent) headerStockContent.classList.remove('hidden');
        if (searchIconBtnMain) searchIconBtnMain.classList.add('hidden');
        
        loading.classList.add('hidden');
        results.classList.remove('hidden');
        
        // Trigger slide-up animation
        requestAnimationFrame(() => {
            results.classList.add('visible');
        });
        
        // Safely get summary values
        const summary = data.summary || {};
        
        // Update top header bar with stock info
        const headerStockTicker = document.getElementById('headerStockTicker');
        const headerStockName = document.getElementById('headerStockName');
        const headerStockPrice = document.getElementById('headerStockPrice');
        const headerStockChange = document.getElementById('headerStockChange');
        
        if (headerStockTicker) headerStockTicker.textContent = data.ticker || '';
        if (headerStockName) headerStockName.textContent = data.name || '';
        if (headerStockPrice && summary.current_price) {
            headerStockPrice.textContent = '$' + summary.current_price.toFixed(2);
        }
        let computedChangePercent = null;
        if (headerStockChange && lastPriceHistory && lastPriceHistory.length >= 2) {
            const prices = lastPriceHistory.map(d => d.close || d.price).filter(v => v != null);
            if (prices.length >= 2) {
                const currentPrice = prices[prices.length - 1];
                const priorClose = prices[prices.length - 2];
                const changePercent = ((currentPrice - priorClose) / priorClose) * 100;
                computedChangePercent = changePercent;
                const isPositive = changePercent >= 0;
                const changeSymbol = isPositive ? '+' : '';
                headerStockChange.textContent = `${changeSymbol}${changePercent.toFixed(2)}%`;
                headerStockChange.className = 'header-change-badge ' + (isPositive ? 'positive' : 'negative');
            }
        }

        // Cache the latest snapshot for the watchlist (so saved tickers can show
        // price + delta on the empty state without re-fetching).
        if (window.Watchlist && data.ticker) {
            window.Watchlist.touchSnapshot(data.ticker, {
                name: data.name || summary.name || '',
                price: summary.current_price ?? null,
                changePercent: computedChangePercent
            });
            window.Watchlist.syncToggleButton();
        }
        
        // Populate About section
        const companyDescription = document.getElementById('companyDescription');
        const companyIndustry = document.getElementById('companyIndustry');
        const companySector = document.getElementById('companySector');
        const companyEmployees = document.getElementById('companyEmployees');
        const companyFounded = document.getElementById('companyFounded');
        const companyHQ = document.getElementById('companyHQ');
        const companyWebsite = document.getElementById('companyWebsite');
        
        const companyName = data.name || summary.name || data.ticker;
        const aboutParts = [];
        if (summary.current_price != null) aboutParts.push(`currently trades around $${summary.current_price.toFixed(2)}`);
        if (summary.market_cap != null) aboutParts.push(`has a market capitalization of ${formatMarketCap(summary.market_cap)}`);
        if (summary.pe_ratio != null) aboutParts.push(`has a P/E ratio of ${summary.pe_ratio.toFixed(2)}`);
        const generatedDescription = aboutParts.length
            ? `${companyName} (${data.ticker}) ${aboutParts.join(', ')}.`
            : `${companyName} (${data.ticker}) is a publicly traded company.`;

        if (companyDescription) {
            companyDescription.textContent = data.description || generatedDescription;
        }
        if (companyIndustry) companyIndustry.textContent = data.industry || data.sector || 'Public company';
        if (companySector) companySector.textContent = data.sector || 'Market data';
        if (companyEmployees) {
            companyEmployees.textContent = data.employees ? data.employees.toLocaleString() : '-';
        }
        if (companyFounded) companyFounded.textContent = data.founded || data.list_date || '-';
        if (companyHQ) companyHQ.textContent = data.hq || data.headquarters || '-';
        if (companyWebsite) {
            if (data.website) {
                companyWebsite.textContent = data.website.replace(/^https?:\/\//, '');
                companyWebsite.href = data.website;
            } else {
                companyWebsite.textContent = '-';
                companyWebsite.href = '#';
            }
        }
        
        // Overview metrics visualization (see overview.js)
        window.StockOverview?.render(data, lastPriceHistory);
        
        // Calculate and display trends based on earnings data
        calculateAndDisplayTrends(data.earnings || []);
        
        // Valuation Metrics (with flash animation on change)
        updateValueWithFlash('psRatio', summary.ps_ratio, formatNumber);
        updateValueWithFlash('pbRatio', summary.pb_ratio, formatNumber);
        updateValueWithFlash('evebitda', summary.ev_ebitda, formatNumber);
        updateValueWithFlash('marketCap2', summary.market_cap, formatMarketCap);
        updateValueWithFlash('enterpriseValue', summary.enterprise_value, formatMarketCap);
        updateValueWithFlash('sharesOutstanding', summary.shares_outstanding, 
            (v) => v ? formatNumber(v / 1e9) + 'B' : '-');
        
        // Profitability Metrics
        document.getElementById('grossMargin').textContent = formatPercent(summary.gross_margin);
        document.getElementById('ebitdaMargin').textContent = formatPercent(summary.ebitda_margin);
        document.getElementById('roa').textContent = formatPercent(summary.roa);
        document.getElementById('roic').textContent = formatPercent(summary.roic);
        
        // Financial Health
        document.getElementById('currentRatio').textContent = formatNumber(summary.current_ratio);
        document.getElementById('quickRatio').textContent = formatNumber(summary.quick_ratio);
        document.getElementById('interestCoverage').textContent = formatNumber(summary.interest_coverage);
        document.getElementById('cash').textContent = formatMarketCap(summary.cash);
        document.getElementById('workingCapital').textContent = formatMarketCap(summary.working_capital);
        
        // Draw charts (reverse data for chronological order)
        const chartData = [...data.earnings].reverse();
        lastChartData = chartData;  // Store for tab switching
        sharesOutstanding = summary.shares_outstanding || 1; // Store for total earnings calc
        
        // Get active tab safely
        const activeTabEl = document.querySelector('.tab-content.active');
        const activeTab = activeTabEl ? activeTabEl.id : 'overview';
        
        console.log(`Drawing charts for active tab: ${activeTab}`);
        
        
        // Draw other charts if their tab is active
        if (activeTab === 'fundamentals') {
            drawRevenueChart(chartData);
            drawFCFChart(chartData);
            drawPEChart(chartData, lastPriceHistory);
        }
        
        // Trigger card entrance animations
        const cards = document.querySelectorAll('#results .card');
        cards.forEach(card => card.classList.remove('animate-in'));
        
        // Force reflow to ensure animation restarts
        void document.body.offsetHeight;
        
        // Add animate-in class with slight delay for stagger effect
        setTimeout(() => {
            cards.forEach((card, index) => {
                setTimeout(() => {
                    card.classList.add('animate-in');
                }, index * 50); // 50ms stagger between cards
            });
        }, 50);
    }

    // Load a ticker only when explicitly requested, keeping the discovery state usable by default.
    const initialTicker = new URLSearchParams(window.location.search).get('ticker')?.trim().toUpperCase();
    if (initialTicker) {
        tickerInput.value = initialTicker;
        setTimeout(() => loadStock(initialTicker), 100);
    }

    // Fetch price history separately to avoid rate limits
    async function fetchPriceHistory(ticker) {
        try {
            console.log(`Fetching price history for ${ticker}...`);
            const response = await fetch(`${API_BASE}/stocks/${ticker}/prices?days=365`, {
                credentials: 'include',
            });
            
            if (!response.ok) {
                console.log('Price history not available (rate limit or error)');
                return;
            }
            
            const data = await response.json();
            if (data.prices && data.prices.length > 0) {
                console.log(`Received ${data.prices.length} price points`);
                lastPriceHistory = data.prices;
                // Also redraw P/E chart if we have earnings data
                if (lastChartData) {
                    const chartData = lastChartData;
                    drawPEChart(chartData, data.prices);
                }
            }
        } catch (err) {
            console.log('Could not fetch price history:', err.message);
        }
    }

    // Chart drawing functions
function drawRevenueChart(data) {
    const canvas = document.getElementById('revenueChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    
    canvas.width = 800 * dpr;
    canvas.height = 250 * dpr;
    ctx.scale(dpr, dpr);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    
    const padding = { top: 30, right: 40, bottom: 50, left: 60 };
    const chartWidth = 800 - padding.left - padding.right;
    const chartHeight = 250 - padding.top - padding.bottom;
    
    ctx.clearRect(0, 0, 800, 250);
    
    const revenues = data.map(d => d.revenue / 1e9).filter(v => v > 0);
    if (revenues.length === 0) {
        ctx.fillStyle = '#6e6555';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No revenue data available', 400, 125);
        return;
    }
    
    const maxRev = Math.max(...revenues) * 1.1;
    
    // Grid
    ctx.strokeStyle = '#ece4d8';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    
    for (let i = 0; i <= 5; i++) {
        const y = padding.top + (chartHeight * i / 5);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + chartWidth, y);
        ctx.stroke();
        
        const val = maxRev - maxRev * i / 5;
        ctx.fillStyle = '#6e6555';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`$${val.toFixed(0)}B`, padding.left - 10, y + 4);
    }
    
    ctx.setLineDash([]);
    
    // Bars
    const barWidth = chartWidth / data.length * 0.6;
    const spacing = chartWidth / data.length;
    
    data.forEach((d, i) => {
        const x = padding.left + spacing * i + (spacing - barWidth) / 2;
        const barHeight = (d.revenue / 1e9 / maxRev) * chartHeight;
        const y = padding.top + chartHeight - barHeight;
        
        ctx.fillStyle = '#10b981';
        ctx.fillRect(x, y, barWidth, barHeight);
        
        ctx.fillStyle = '#6e6555';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(formatQuarterLabel(d), x + barWidth / 2, padding.top + chartHeight + 20);
    });
}

function drawFCFChart(data) {
    const canvas = document.getElementById('fcfChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    
    canvas.width = 800 * dpr;
    canvas.height = 250 * dpr;
    ctx.scale(dpr, dpr);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    
    const padding = { top: 30, right: 60, bottom: 50, left: 60 };
    const chartWidth = 800 - padding.left - padding.right;
    const chartHeight = 250 - padding.top - padding.bottom;
    
    ctx.clearRect(0, 0, 800, 250);
    
    const fcfs = data.map(d => d.free_cash_flow / 1e9).filter(v => v > 0);
    if (fcfs.length === 0) {
        ctx.fillStyle = '#6e6555';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No free cash flow data available', 400, 125);
        return;
    }
    
    const maxFCF = Math.max(...fcfs) * 1.1;
    
    // Grid
    ctx.strokeStyle = '#ece4d8';
    ctx.setLineDash([5, 5]);
    
    for (let i = 0; i <= 5; i++) {
        const y = padding.top + (chartHeight * i / 5);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + chartWidth, y);
        ctx.stroke();
        
        const val = maxFCF - maxFCF * i / 5;
        ctx.fillStyle = '#6e6555';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`$${val.toFixed(0)}B`, padding.left - 10, y + 4);
    }
    
    ctx.setLineDash([]);
    
    // Bars (FCF)
    const barWidth = chartWidth / data.length * 0.5;
    const spacing = chartWidth / data.length;
    
    data.forEach((d, i) => {
        const x = padding.left + spacing * i + (spacing - barWidth) / 2;
        const barHeight = (d.free_cash_flow / 1e9 / maxFCF) * chartHeight;
        const y = padding.top + chartHeight - barHeight;
        
        ctx.fillStyle = '#06b6d4';
        ctx.fillRect(x, y, barWidth, barHeight);
        
        ctx.fillStyle = '#6e6555';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(formatQuarterLabel(d), x + barWidth / 2, padding.top + chartHeight + 20);
    });
    
    // Legend
    ctx.fillStyle = '#06b6d4';
    ctx.fillRect(padding.left, 10, 15, 15);
    ctx.fillStyle = '#5d574e';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Free Cash Flow', padding.left + 20, 22);
}

function drawPEChart(data, priceHistory = null) {
    const canvas = document.getElementById('peChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    
    canvas.width = 800 * dpr;
    canvas.height = 250 * dpr;
    ctx.scale(dpr, dpr);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    
    const padding = { top: 30, right: 40, bottom: 50, left: 60 };
    const chartWidth = 800 - padding.left - padding.right;
    const chartHeight = 250 - padding.top - padding.bottom;
    
    ctx.clearRect(0, 0, 800, 250);
    
    // Calculate P/E from price history if available
    let peData = data.map(d => ({ ...d }));
    
    if (priceHistory && priceHistory.length > 0) {
        // Create price lookup by date
        const priceByDate = {};
        priceHistory.forEach(p => {
            priceByDate[p.date] = p.close;
        });
        
        // Calculate P/E for each quarter
        peData = peData.map((d, i) => {
            const entry = { ...d };
            
            // Calculate TTM EPS (sum of this + 3 previous quarters)
            let ttmEps = 0;
            let quarters = 0;
            for (let j = i; j < Math.min(i + 4, peData.length); j++) {
                if (peData[j].reported_eps > 0) {
                    ttmEps += peData[j].reported_eps;
                    quarters++;
                }
            }
            
            // Find price on or near earnings date
            if (quarters >= 3 && ttmEps > 0) {
                const fiscalDate = d.fiscal_date;
                let price = priceByDate[fiscalDate];
                
                // Try nearby dates if exact match not found
                if (!price) {
                    const date = new Date(fiscalDate);
                    for (let offset = 1; offset <= 5 && !price; offset++) {
                        const fwd = new Date(date);
                        fwd.setDate(fwd.getDate() + offset);
                        price = priceByDate[fwd.toISOString().split('T')[0]];
                        
                        if (!price) {
                            const back = new Date(date);
                            back.setDate(back.getDate() - offset);
                            price = priceByDate[back.toISOString().split('T')[0]];
                        }
                    }
                }
                
                if (price) {
                    entry.pe_ratio = price / ttmEps;
                    entry.price = price;
                }
            }
            
            return entry;
        });
    }
    
    const pes = peData.map(d => d.pe_ratio).filter(v => v != null && !isNaN(v));
    
    if (pes.length === 0) {
        ctx.fillStyle = '#6e6555';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No P/E data available', 400, 125);
        return;
    }
    
    const maxPE = Math.max(...pes) * 1.1;
    const minPE = Math.min(...pes) * 0.9;
    
    // Industry average P/E reference line (S&P 500 ~20-25)
    const industryAvgPE = 22;
    if (industryAvgPE >= minPE && industryAvgPE <= maxPE) {
        const avgY = padding.top + chartHeight - ((industryAvgPE - minPE) / (maxPE - minPE)) * chartHeight;
        ctx.save();
        ctx.strokeStyle = '#f59e0b'; // Orange for benchmark
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(padding.left, avgY);
        ctx.lineTo(padding.left + chartWidth, avgY);
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#f59e0b';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('S&P 500 Avg (~22)', padding.left + chartWidth, avgY - 5);
        ctx.restore();
    }
    
    // Grid
    ctx.strokeStyle = '#ece4d8';
    ctx.setLineDash([5, 5]);
    
    for (let i = 0; i <= 5; i++) {
        const y = padding.top + (chartHeight * i / 5);
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + chartWidth, y);
        ctx.stroke();
        
        const val = maxPE - (maxPE - minPE) * i / 5;
        ctx.fillStyle = '#6e6555';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${val.toFixed(0)}x`, padding.left - 10, y + 4);
    }
    
    ctx.setLineDash([]);
    
    // Area chart (simplified as line with fill)
    const spacing = chartWidth / (peData.length - 1);
    
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top + chartHeight);
    
    peData.forEach((d, i) => {
        if (d.pe_ratio != null && !isNaN(d.pe_ratio)) {
            const x = padding.left + spacing * i;
            const y = padding.top + chartHeight - ((d.pe_ratio - minPE) / (maxPE - minPE)) * chartHeight;
            ctx.lineTo(x, y);
        }
    });
    
    ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
    ctx.closePath();
    
    ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
    ctx.fill();
    
    // Line
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    
    let started = false;
    peData.forEach((d, i) => {
        if (d.pe_ratio != null && !isNaN(d.pe_ratio)) {
            const x = padding.left + spacing * i;
            const y = padding.top + chartHeight - ((d.pe_ratio - minPE) / (maxPE - minPE)) * chartHeight;
            
            if (!started) {
                ctx.moveTo(x, y);
                started = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
    });
    ctx.stroke();
    
    // X labels
    peData.forEach((d, i) => {
        const x = padding.left + spacing * i;
        ctx.fillStyle = '#6e6555';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(formatQuarterLabel(d), x, padding.top + chartHeight + 20);
    });
}

function formatQuarterLabel(entry) {
    const date = new Date(`${entry.fiscal_date}T00:00:00`);
    if (Number.isNaN(date.getTime())) return entry.period || '';

    const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
    const year = String(date.getUTCFullYear()).slice(-2);
    return `Q${quarter} '${year}`;
}

    // Pull-to-refresh for mobile
    function initPullToRefresh() {
        const pullThreshold = 100;
        let startY = 0;
        let currentY = 0;
        let isPulling = false;
        let refreshIndicator = null;
        
        // Only enable on mobile
        if (window.innerWidth > 768) return;
        
        // Create refresh indicator
        refreshIndicator = document.createElement('div');
        refreshIndicator.className = 'pull-refresh-indicator';
        refreshIndicator.innerHTML = '<div class="pull-refresh-spinner"></div><span>Pull to refresh</span>';
        refreshIndicator.style.cssText = `
            position: fixed;
            top: -60px;
            left: 0;
            right: 0;
            height: 60px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--bg-tertiary);
            transition: transform 0.2s ease;
            z-index: 100;
            font-size: 13px;
            color: var(--text-muted);
        `;
        document.body.appendChild(refreshIndicator);
        
        const main = document.getElementById('main');
        
        main.addEventListener('touchstart', (e) => {
            // Only trigger if at top of page
            if (window.scrollY > 0) return;
            
            startY = e.touches[0].clientY;
            isPulling = true;
        }, { passive: true });
        
        main.addEventListener('touchmove', (e) => {
            if (!isPulling) return;
            
            currentY = e.touches[0].clientY;
            const diff = currentY - startY;
            
            if (diff > 0 && window.scrollY === 0) {
                // Prevent default scroll when pulling down at top
                if (diff < pullThreshold) {
                    e.preventDefault();
                }
                
                // Move indicator
                const translateY = Math.min(diff * 0.5, pullThreshold);
                refreshIndicator.style.transform = `translateY(${translateY}px)`;
                
                // Update text based on pull distance
                const span = refreshIndicator.querySelector('span');
                if (translateY >= pullThreshold * 0.7) {
                    span.textContent = 'Release to refresh';
                    refreshIndicator.querySelector('.pull-refresh-spinner').style.animation = 'spin 0.5s linear infinite';
                } else {
                    span.textContent = 'Pull to refresh';
                    refreshIndicator.querySelector('.pull-refresh-spinner').style.animation = 'none';
                }
            }
        }, { passive: false });
        
        main.addEventListener('touchend', () => {
            if (!isPulling) return;
            
            const diff = currentY - startY;
            
            if (diff > pullThreshold * 0.7 && currentTicker) {
                // Trigger refresh
                refreshIndicator.querySelector('span').textContent = 'Refreshing...';
                refreshIndicator.style.transform = 'translateY(0)';
                
                loadStock(currentTicker, true).then(() => {
                    // Reset after refresh
                    setTimeout(() => {
                        refreshIndicator.style.transform = 'translateY(-60px)';
                    }, 500);
                });
            } else {
                // Reset without refreshing
                refreshIndicator.style.transform = 'translateY(-60px)';
            }
            
            isPulling = false;
            startY = 0;
            currentY = 0;
        });
    }
    
    // Initialize pull-to-refresh on mobile
    initPullToRefresh();
});
