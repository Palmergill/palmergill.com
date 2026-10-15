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
        if (lastChartData && tabId !== 'about') {
            setTimeout(() => window.StockOverview?.redraw(), 10);
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
        
        // Shelby easter egg (shelby.js)
        if (ticker === 'SHELBY') {
            window.ShelbyEgg?.show();
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
        // Every entry point (Enter on a suggestion, ?ticker=) reaches here.
        if (ticker === 'SHELBY') {
            window.ShelbyEgg?.show();
            return;
        }
        currentTicker = ticker;
        if (attempt === 1) {
            lastChartData = null;
            lastPriceHistory = null;
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
        
        lastChartData = data.earnings || [];  // Marks data loaded for tab-switch redraws
        
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
            }
        } catch (err) {
            console.log('Could not fetch price history:', err.message);
        }
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
