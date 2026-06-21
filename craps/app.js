const rules = window.CrapsRules;
const betNames = rules.BET_NAMES;
const casinoProfile = window.CasinoProfile || null;

// ── Game State ──
let balance = casinoProfile ? casinoProfile.getBankroll() : 1000;
let point = null;
let isComeOutRoll = true;
let lastBets = null;
let currentModalBet = null;
let currentOddsTarget = null;
let nextComeBetId = 1;
let isRolling = false;
let rollResultTimer = null;
let selectedChip = 5;

// Multiple Come/Don't Come bets: array of { id, point: null|number, amount: number, odds: number }
let comeBets = [];
let dontComeBets = [];

// All bet types (no longer includes come/dontCome)
let bets = {
    passLine: 0, dontPass: 0,
    any7: 0, anyCraps: 0, field: 0,
    craps2: 0, craps3: 0, craps12: 0, yo11: 0,
    hard4: 0, hard6: 0, hard8: 0, hard10: 0,
    place4: 0, place5: 0, place6: 0, place8: 0, place9: 0, place10: 0
};

// Odds bets for pass/don't pass only
let oddsBets = { passLine: 0, dontPass: 0 };

const dicePatterns = {
    1: [[2,2]], 2: [[1,1],[3,3]], 3: [[1,1],[2,2],[3,3]],
    4: [[1,1],[1,3],[3,1],[3,3]], 5: [[1,1],[1,3],[2,2],[3,1],[3,3]],
    6: [[1,1],[1,3],[2,1],[2,3],[3,1],[3,3]]
};

// ── UI: Balance ──
function updateBalance() {
    document.getElementById('balance').textContent = '$' + balance.toLocaleString();
    const balanceEl = document.getElementById('balance');
    if (balanceEl) {
        balanceEl.classList.remove('win-flash', 'loss-flash');
    }
    if (casinoProfile) casinoProfile.setBankroll(balance);
}

function setStatus(message) {
    const status = document.getElementById('gameStatus');
    if (status) status.textContent = message;
}

function showRollResultAnimation(amount) {
    const burst = document.getElementById('rollResultBurst');
    if (rollResultTimer) clearTimeout(rollResultTimer);

    burst.className = 'roll-result-burst';
    if (amount === 0) {
        burst.textContent = '';
        rollResultTimer = null;
        return;
    }

    burst.textContent = (amount > 0 ? '+$' : '-$') + Math.abs(amount).toLocaleString();
    burst.offsetHeight;
    burst.classList.add(amount > 0 ? 'win' : 'loss', 'active');

    rollResultTimer = setTimeout(() => {
        burst.classList.remove('active');
        rollResultTimer = null;
    }, 1200);
}

// ── UI: Dice ──
function renderDie(dieId, value) {
    const die = document.getElementById(dieId);
    die.innerHTML = '';
    // dicePatterns only covers 1–6. Out-of-range values would otherwise crash
    // the dot loop below; render a blank face instead.
    const pattern = dicePatterns[value] || [];
    for (let row = 1; row <= 3; row++) {
        for (let col = 1; col <= 3; col++) {
            const dot = document.createElement('div');
            dot.className = 'die-dot';
            if (!pattern.some(p => p[0] === row && p[1] === col)) dot.classList.add('hidden');
            dot.style.gridRow = row;
            dot.style.gridColumn = col;
            die.appendChild(dot);
        }
    }
}

function updatePhaseDisplay() {
    const phaseText = document.getElementById('phaseText');
    const phaseHint = document.getElementById('phaseHint');
    const puck = document.getElementById('puck');
    const pointDisplay = document.getElementById('pointDisplay');
    if (isComeOutRoll) {
        if (phaseText) phaseText.textContent = 'COME-OUT';
        if (phaseHint) phaseHint.textContent = 'Puck off';
        if (puck) {
            puck.textContent = 'OFF';
            puck.className = 'puck off';
        }
        if (pointDisplay) pointDisplay.textContent = '';
    } else {
        if (phaseText) phaseText.textContent = 'POINT ' + point;
        if (phaseHint) phaseHint.textContent = 'Puck on ' + point;
        if (puck) {
            puck.textContent = 'ON';
            puck.className = 'puck on';
        }
        if (pointDisplay) pointDisplay.textContent = 'POINT: ' + point;
    }
}

// ── Submenus ──
function closePlaceMenu() { document.getElementById('placeMenu').classList.remove('active'); }
function openCenterMenu() {
    const menu = document.getElementById('centerMenu');
    const trigger = document.getElementById('centerBoardBtn');
    menu.classList.add('active', 'open');
    menu.setAttribute('aria-hidden', 'false');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
}
function closeCenterMenu() {
    const menu = document.getElementById('centerMenu');
    const trigger = document.getElementById('centerBoardBtn');
    menu.classList.remove('active', 'open');
    menu.setAttribute('aria-hidden', 'true');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function selectChip(amount) {
    selectedChip = Number(amount);
    document.querySelectorAll('.tray-chip').forEach((chip) => {
        const isSelected = Number(chip.dataset.chip) === selectedChip;
        chip.classList.toggle('selected', isSelected);
        chip.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    });
}

function applyFlatBet(betType, amount) {
    if (betType === 'come') {
        comeBets.push({ id: nextComeBetId++, point: null, amount: amount, odds: 0 });
    } else if (betType === 'dontCome') {
        dontComeBets.push({ id: nextComeBetId++, point: null, amount: amount, odds: 0 });
    } else {
        bets[betType] += amount;
    }
    balance -= amount;
    updateBalance();
    updateAllDisplays();
    setStatus('Placed $' + amount + ' on ' + (betNames[betType] || (betType === 'come' ? 'Come' : "Don't Come")));
}

function placeSelectedChip(betType) {
    if ((betType === 'come' || betType === 'dontCome') && isComeOutRoll) {
        setStatus('Come bets open after a point is set.');
        return;
    }
    if ((betType === 'passLine' || betType === 'dontPass') &&
            bets[betType] > 0 && canManageOdds(betType)) {
        openOddsModal(betType);
        return;
    }
    if (!canAddBet(betType)) {
        setStatus('Contract bets stay until resolved');
        return;
    }
    const validationError = getBetValidationError(betType, selectedChip);
    if (validationError) {
        setStatus(validationError);
        openBetModal(betType);
        document.getElementById('betInput').value = selectedChip;
        document.getElementById('modalCurrentBet').textContent = validationError;
        return;
    }
    applyFlatBet(betType, selectedChip);
}

// ── Bet Modal ──
function openBetModal(betType) {
    // Block come/don't come on come-out
    if ((betType === 'come' || betType === 'dontCome') && isComeOutRoll) return;
    if ((betType === 'passLine' || betType === 'dontPass') &&
            bets[betType] > 0 && canManageOdds(betType)) {
        openOddsModal(betType);
        return;
    }

    currentModalBet = betType;
    currentOddsTarget = null;
    const isComeBet = (betType === 'come' || betType === 'dontCome');
    const name = isComeBet ? (betType === 'come' ? 'Come' : "Don't Come") : (betNames[betType] || betType);
    document.getElementById('modalTitle').textContent = name + ' Bet';

    const explain = document.getElementById('modalBetExplain');
    if (explain) {
        const info = BET_INFO[betType];
        if (info) {
            const heading = document.createElement('strong');
            heading.textContent = 'How it works';
            const body = document.createTextNode(info.rule);
            const br = document.createElement('br');
            const edge = document.createElement('span');
            edge.className = 'edge';
            edge.textContent = `Pays ${info.payout} · House edge ${info.edge}`;
            explain.replaceChildren(heading, body, br, edge);
        } else {
            explain.replaceChildren();
        }
    }
    const betInput = document.getElementById('betInput');
    betInput.value = '';
    betInput.min = getBetUnit(betType);
    betInput.step = getBetUnit(betType);

    // Show current bet info
    let info = '';
    if (isComeBet) {
        const arr = betType === 'come' ? comeBets : dontComeBets;
        if (arr.length > 0) {
            info = arr.length + ' active ' + name + ' bet' + (arr.length > 1 ? 's' : '');
        }
    } else {
        const current = bets[betType] || 0;
        const oddsAmt = oddsBets[betType] || 0;
        if (current > 0) {
            info = 'Current: $' + current;
            if (oddsAmt > 0) info += ' + $' + oddsAmt + ' odds';
        }
    }
    const unit = getBetUnit(betType);
    if (unit > 5) {
        info = (info ? info + ' · ' : '') + 'Use $' + unit + ' increments';
    }
    document.getElementById('modalCurrentBet').textContent = info;

    // Show remove button if there's a current bet (not for come/dontCome - those are managed via strip)
    const actionsDiv = document.getElementById('modalActions');
    const current = isComeBet ? 0 : (bets[betType] || 0);
    const canRemove = current > 0 && canClearBet(betType);
    if (current > 0 && canRemove) {
        actionsDiv.className = 'modal-actions three-col';
        actionsDiv.innerHTML = '<button class="modal-btn cancel" onclick="closeBetModal()">Cancel</button>' +
            '<button class="modal-btn remove" onclick="removeBetFromModal()">Remove</button>' +
            '<button class="modal-btn confirm" onclick="confirmBet()">Add</button>';
    } else if (current > 0 && !canAddBet(betType)) {
        actionsDiv.className = 'modal-actions';
        actionsDiv.innerHTML = '<button class="modal-btn cancel" onclick="closeBetModal()">Done</button>';
    } else {
        actionsDiv.className = 'modal-actions';
        actionsDiv.innerHTML = '<button class="modal-btn cancel" onclick="closeBetModal()">Cancel</button>' +
            '<button class="modal-btn confirm" onclick="confirmBet()">Place Bet</button>';
    }

    document.getElementById('betModal').classList.add('active');
    setTimeout(() => document.getElementById('betInput').focus(), 100);
}

function setModalAmt(amt) { document.getElementById('betInput').value = amt; }

function closeBetModal() {
    document.getElementById('betModal').classList.remove('active');
    currentModalBet = null;
    currentOddsTarget = null;
}

function getBetUnit(betType) {
    return rules.getBetUnit(betType);
}

function getBetValidationError(betType, amount) {
    return rules.validateBetAmount(betType, amount, balance);
}

function confirmBet() {
    if (!currentModalBet) return;
    if (!canAddBet(currentModalBet)) {
        setStatus('Contract bets stay until resolved');
        return;
    }
    const amt = Number(document.getElementById('betInput').value);
    const validationError = getBetValidationError(currentModalBet, amt);
    if (validationError) {
        document.getElementById('modalCurrentBet').textContent = validationError;
        setStatus(validationError);
        return;
    }

    if (currentModalBet === 'come') {
        comeBets.push({ id: nextComeBetId++, point: null, amount: amt, odds: 0 });
    } else if (currentModalBet === 'dontCome') {
        dontComeBets.push({ id: nextComeBetId++, point: null, amount: amt, odds: 0 });
    } else {
        bets[currentModalBet] += amt;
    }
    balance -= amt;
    updateBalance();
    updateAllDisplays();
    closeBetModal();
}

function removeBetFromModal() {
    if (!currentModalBet) return;
    const bt = currentModalBet;
    if (!canClearBet(bt)) {
        setStatus('Contract bets stay until resolved');
        closeBetModal();
        return;
    }
    balance += bets[bt] + (oddsBets[bt] || 0);
    bets[bt] = 0;
    if (oddsBets[bt] !== undefined) oddsBets[bt] = 0;
    updateBalance();
    updateAllDisplays();
    closeBetModal();
}

// ── Odds ──
function getOddsPayout(p, isPass) {
    return rules.getOddsPayout(p, isPass);
}

function addOddsToBet(bet, multiplier, isPass = true) {
    const canAfford = rules.calculateOddsToAdd({
        point: bet?.point,
        amount: bet?.amount || 0,
        odds: bet?.odds || 0,
        balance,
        multiplier,
        isPass
    });
    if (!canAfford) return false;
    bet.odds += canAfford;
    balance -= canAfford;
    return true;
}

function getOddsContext(betType, betId = null) {
    if (betType === 'passLine' || betType === 'dontPass') {
        if (!point || bets[betType] <= 0) return null;
        return {
            betType: betType,
            betId: null,
            point: point,
            amount: bets[betType],
            odds: oddsBets[betType],
            label: betNames[betType]
        };
    }

    const arr = betType === 'dontCome' ? dontComeBets : comeBets;
    const bet = arr.find(b => b.id === betId);
    if (!bet || !bet.point || bet.amount <= 0) return null;
    return {
        betType: betType,
        betId: betId,
        point: bet.point,
        amount: bet.amount,
        odds: bet.odds,
        label: (betType === 'dontCome' ? 'DC ' : 'Come ') + bet.point
    };
}

function setOddsAmount(betType, betId, amount) {
    if (betType === 'passLine' || betType === 'dontPass') {
        oddsBets[betType] = amount;
        return true;
    }
    const arr = betType === 'dontCome' ? dontComeBets : comeBets;
    const bet = arr.find(b => b.id === betId);
    if (!bet) return false;
    bet.odds = amount;
    return true;
}

function canManageOdds(betType, betId = null) {
    return getOddsContext(betType, betId) !== null;
}

function getMaxOddsAmount(context) {
    return rules.getMaxOddsAmount(context.amount, context.point);
}

function openOddsModal(betType, betId = null) {
    const context = getOddsContext(betType, betId);
    if (!context) {
        setStatus('Odds are available after a point is set');
        return;
    }

    currentModalBet = null;
    currentOddsTarget = { betType: betType, betId: betId };
    const maxOdds = getMaxOddsAmount(context);
    const remaining = Math.max(0, maxOdds - context.odds);
    const betInput = document.getElementById('betInput');
    betInput.value = '';
    betInput.min = 5;
    betInput.step = 5;
    betInput.placeholder = context.odds > 0 ? String(context.odds) : '0';

    document.getElementById('modalTitle').textContent = context.label + ' Odds';
    document.getElementById('modalCurrentBet').textContent =
        'Bet $' + context.amount + ' on ' + context.point +
        ' · Odds $' + context.odds + ' / $' + maxOdds +
        (remaining > 0 ? ' · Can add $' + remaining : ' · Max odds');

    const actionsDiv = document.getElementById('modalActions');
    if (context.odds > 0) {
        actionsDiv.className = 'modal-actions three-col';
        actionsDiv.innerHTML = '<button class="modal-btn cancel" onclick="closeBetModal()">Cancel</button>' +
            '<button class="modal-btn remove" onclick="removeOddsFromModal()">Remove Odds</button>' +
            '<button class="modal-btn confirm" onclick="addOddsFromModal()">Add Odds</button>';
    } else {
        actionsDiv.className = 'modal-actions';
        actionsDiv.innerHTML = '<button class="modal-btn cancel" onclick="closeBetModal()">Cancel</button>' +
            '<button class="modal-btn confirm" onclick="addOddsFromModal()">Add Odds</button>';
    }

    document.getElementById('betModal').classList.add('active');
    setTimeout(() => document.getElementById('betInput').focus(), 100);
}

function addOddsFromModal() {
    if (!currentOddsTarget) return;
    const context = getOddsContext(currentOddsTarget.betType, currentOddsTarget.betId);
    if (!context) {
        closeBetModal();
        return;
    }

    const amount = Number(document.getElementById('betInput').value);
    if (!Number.isInteger(amount) || amount < 5) {
        document.getElementById('modalCurrentBet').textContent = 'Enter at least $5 in odds';
        setStatus('Enter at least $5 in odds');
        return;
    }

    const maxOdds = getMaxOddsAmount(context);
    const remaining = maxOdds - context.odds;
    if (remaining < 5) {
        document.getElementById('modalCurrentBet').textContent = 'Odds are already maxed';
        setStatus('Odds are already maxed');
        return;
    }
    if (balance < 5) {
        document.getElementById('modalCurrentBet').textContent = 'Not enough balance';
        setStatus('Not enough balance');
        return;
    }

    const isPass = context.betType === 'passLine' || context.betType === 'come';
    const added = rules.legalOddsAmount({
        point: context.point,
        requested: amount,
        remaining,
        balance,
        isPass
    });
    if (!added) {
        document.getElementById('modalCurrentBet').textContent = 'Enter a legal odds increment';
        setStatus('Enter a legal odds increment');
        return;
    }
    setOddsAmount(context.betType, context.betId, context.odds + added);
    balance -= added;
    updateBalance();
    updateAllDisplays();
    setStatus('Added $' + added + ' odds to ' + context.label);
    closeBetModal();
}

function removeOddsFromModal() {
    if (!currentOddsTarget) return;
    const context = getOddsContext(currentOddsTarget.betType, currentOddsTarget.betId);
    if (!context || context.odds <= 0) {
        setStatus('No odds to remove');
        closeBetModal();
        return;
    }

    const rawAmount = document.getElementById('betInput').value;
    const amount = rawAmount === '' ? context.odds : Number(rawAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
        document.getElementById('modalCurrentBet').textContent = 'Enter an odds amount to remove';
        setStatus('Enter an odds amount to remove');
        return;
    }

    const removed = Math.min(amount, context.odds);
    setOddsAmount(context.betType, context.betId, context.odds - removed);
    balance += removed;
    updateBalance();
    updateAllDisplays();
    setStatus('Removed $' + removed + ' odds from ' + context.label);
    closeBetModal();
}

function takeMaxOdds(bt) {
    let pt;
    if (bt === 'passLine' || bt === 'dontPass') { pt = point; }
    if (!pt || bets[bt] === 0) return;
    const lineBet = { point: pt, amount: bets[bt], odds: oddsBets[bt] };
    if (addOddsToBet(lineBet, 'max', bt === 'passLine')) {
        oddsBets[bt] = lineBet.odds;
        updateBalance();
        updateAllDisplays();
    }
}

function takeMaxOddsComeBet(index, isDontCome) {
    const arr = isDontCome ? dontComeBets : comeBets;
    if (index < 0 || index >= arr.length) return;
    const bet = arr[index];
    if (addOddsToBet(bet, 'max', !isDontCome)) {
        updateBalance();
        updateAllDisplays();
    }
}

function takeMaxOddsAll() {
    ['passLine', 'dontPass'].forEach(bt => takeMaxOdds(bt));
    comeBets.forEach((bet, i) => { if (bet.point) takeMaxOddsComeBet(i, false); });
    dontComeBets.forEach((bet, i) => { if (bet.point) takeMaxOddsComeBet(i, true); });
}

// ── Clear Bets ──
function canClearBet(bt) {
    return !(bt === 'passLine' && !isComeOutRoll && bets.passLine > 0);
}

function canAddBet(bt) {
    return canClearBet(bt);
}

function canClearComeBet(index, isDontCome) {
    const arr = isDontCome ? dontComeBets : comeBets;
    if (index < 0 || index >= arr.length) return false;
    const bet = arr[index];
    return isDontCome || !bet.point;
}

function hasLockedContractBets() {
    return (!isComeOutRoll && bets.passLine > 0) || comeBets.some(bet => bet.point);
}

function clearBet(bt) {
    if (!canClearBet(bt)) {
        setStatus('Contract bets stay until resolved');
        return;
    }
    balance += bets[bt] + (oddsBets[bt] || 0);
    bets[bt] = 0;
    if (oddsBets[bt] !== undefined) oddsBets[bt] = 0;
    updateBalance();
    updateAllDisplays();
}

function clearComeBet(index, isDontCome) {
    const arr = isDontCome ? dontComeBets : comeBets;
    if (index < 0 || index >= arr.length) return;
    if (!canClearComeBet(index, isDontCome)) {
        setStatus('Contract bets stay until resolved');
        return;
    }
    const bet = arr[index];
    balance += bet.amount + bet.odds;
    arr.splice(index, 1);
    updateBalance();
    updateAllDisplays();
}

function clearAllBets() {
    clearPendingPointPopups();
    Object.keys(bets).forEach(bt => {
        if (canClearBet(bt)) {
            balance += bets[bt] + (oddsBets[bt] || 0);
            bets[bt] = 0;
            if (oddsBets[bt] !== undefined) oddsBets[bt] = 0;
        }
    });
    const lockedComeBets = [];
    comeBets.forEach(b => {
        if (b.point) lockedComeBets.push(b);
        else balance += b.amount + b.odds;
    });
    dontComeBets.forEach(b => { balance += b.amount + b.odds; });
    comeBets = lockedComeBets;
    dontComeBets = [];
    updateBalance();
    updateAllDisplays();
}

const BET_INFO = {
    passLine: { rule: "Even-money line bet. Come-out wins on 7/11, loses on 2/3/12. After point: wins if point repeats before 7.", payout: "1:1", edge: "1.41%" },
    dontPass: { rule: "Inverse of pass. Come-out wins on 2/3, push on 12, loses on 7/11. After point: wins on 7 before point.", payout: "1:1", edge: "1.36%" },
    come: { rule: "Acts like pass line but bet after the point. Next roll sets its own come point.", payout: "1:1", edge: "1.41%" },
    dontCome: { rule: "Inverse of come. Establishes its own come point on the next roll.", payout: "1:1", edge: "1.36%" },
    field: { rule: "Single-roll bet on 2, 3, 4, 9, 10, 11, 12. Pays double on 2 and 12.", payout: "1:1 (2:1 on 2/12)", edge: "5.56%" },
    place4: { rule: "Wins if 4 rolls before 7. Off on come-out by default.", payout: "9:5", edge: "6.67%" },
    place5: { rule: "Wins if 5 rolls before 7.", payout: "7:5", edge: "4.00%" },
    place6: { rule: "Wins if 6 rolls before 7. One of the best place bets.", payout: "7:6", edge: "1.52%" },
    place8: { rule: "Wins if 8 rolls before 7. One of the best place bets.", payout: "7:6", edge: "1.52%" },
    place9: { rule: "Wins if 9 rolls before 7.", payout: "7:5", edge: "4.00%" },
    place10: { rule: "Wins if 10 rolls before 7.", payout: "9:5", edge: "6.67%" },
    any7: { rule: "One-roll bet on any 7. High variance, big edge.", payout: "4:1", edge: "16.67%" },
    anyCraps: { rule: "One-roll bet on 2, 3, or 12.", payout: "7:1", edge: "11.11%" },
    craps2: { rule: "One-roll bet on exactly 2.", payout: "30:1", edge: "13.89%" },
    craps3: { rule: "One-roll bet on exactly 3.", payout: "15:1", edge: "11.11%" },
    craps12: { rule: "One-roll bet on exactly 12.", payout: "30:1", edge: "13.89%" },
    yo11: { rule: "One-roll bet on exactly 11.", payout: "15:1", edge: "11.11%" },
    hard4: { rule: "Wins if 2-2 rolls before any other 4 or any 7.", payout: "7:1", edge: "11.11%" },
    hard6: { rule: "Wins if 3-3 rolls before any other 6 or any 7.", payout: "9:1", edge: "9.09%" },
    hard8: { rule: "Wins if 4-4 rolls before any other 8 or any 7.", payout: "9:1", edge: "9.09%" },
    hard10: { rule: "Wins if 5-5 rolls before any other 10 or any 7.", payout: "7:1", edge: "11.11%" }
};

function repeatLastBets() {
    if (!lastBets) return;
    if (hasLockedContractBets()) {
        setStatus('Repeat is available after contract bets resolve');
        return;
    }
    clearAllBets();
    Object.keys(lastBets.bets).forEach(bt => {
        const amt = lastBets.bets[bt];
        if (amt > 0 && amt <= balance) {
            bets[bt] = amt;
            balance -= amt;
        }
    });
    // Repeat come/don't come bets if not come-out
    if (!isComeOutRoll && lastBets.comeBets) {
        lastBets.comeBets.forEach(b => {
            if (b.amount <= balance) {
                comeBets.push({ id: nextComeBetId++, point: null, amount: b.amount, odds: 0 });
                balance -= b.amount;
            }
        });
    }
    if (!isComeOutRoll && lastBets.dontComeBets) {
        lastBets.dontComeBets.forEach(b => {
            if (b.amount <= balance) {
                dontComeBets.push({ id: nextComeBetId++, point: null, amount: b.amount, odds: 0 });
                balance -= b.amount;
            }
        });
    }
    updateBalance();
    updateAllDisplays();
}

// ── Display Updates ──
function updateAllDisplays() {
    updatePhaseDisplay();

    // Main bet buttons
    updateMainBetBtn('passLine', 'passLineBtn', 'passLineInfo');
    updateMainBetBtn('dontPass', 'dontPassBtn', 'dontPassInfo');

    // Come/Don't Come enabled state
    const comeBtn = document.getElementById('comeBtn');
    const dcBtn = document.getElementById('dontComeBtn');
    if (isComeOutRoll) {
        comeBtn.classList.add('disabled');
        dcBtn.classList.add('disabled');
        comeBtn.disabled = true;
        dcBtn.disabled = true;
    } else {
        comeBtn.classList.remove('disabled');
        dcBtn.classList.remove('disabled');
        comeBtn.disabled = false;
        dcBtn.disabled = false;
    }

    // Come bet button display (odds render as gold chips on the number boards)
    const comeInfoEl = document.getElementById('comeInfo');
    if (comeBets.length > 0) {
        const totalAmt = comeBets.reduce((s, b) => s + b.amount, 0);
        const pts = comeBets.filter(b => b.point).map(b => b.point);
        let text = '$' + totalAmt;
        if (pts.length > 0) text += ' \u2022 ' + pts.join(',');
        const waiting = comeBets.filter(b => !b.point).length;
        if (waiting > 0) text += ' \u2022 ' + waiting + ' new';
        comeInfoEl.textContent = text;
    } else {
        comeInfoEl.textContent = 'Tap to bet';
    }

    // Don't Come bet button display (odds render as gold chips on the number boards)
    const dcInfoEl = document.getElementById('dontComeInfo');
    if (dontComeBets.length > 0) {
        const totalAmt = dontComeBets.reduce((s, b) => s + b.amount, 0);
        const pts = dontComeBets.filter(b => b.point).map(b => b.point);
        let text = '$' + totalAmt;
        if (pts.length > 0) text += ' \u2022 ' + pts.join(',');
        const waiting = dontComeBets.filter(b => !b.point).length;
        if (waiting > 0) text += ' \u2022 ' + waiting + ' new';
        dcInfoEl.textContent = text;
    } else {
        dcInfoEl.textContent = 'Tap to bet';
    }

    // Place bet buttons
    ['place4','place5','place6','place8','place9','place10'].forEach(bt => {
        const btn = document.getElementById(bt + 'Btn');
        const boardBtn = document.getElementById('boardPlace' + bt.replace('place', '') + 'Btn');
        const info = document.getElementById(bt + 'Info');
        if (bets[bt] > 0) {
            btn.classList.add('has-bet');
            if (boardBtn) boardBtn.classList.add('has-bet');
            info.textContent = '$' + bets[bt];
        } else {
            btn.classList.remove('has-bet');
            if (boardBtn) boardBtn.classList.remove('has-bet');
            info.textContent = '';
        }
    });

    // Place info summary
    const placeBetList = ['place4','place5','place6','place8','place9','place10'];
    const activePlaces = placeBetList.filter(b => bets[b] > 0);
    const placeTotal = placeBetList.reduce((s, b) => s + bets[b], 0);
    document.getElementById('placeInfo').textContent = activePlaces.length > 0
        ? activePlaces.length + ' numbers \u2022 $' + placeTotal
        : '4, 5, 6, 8, 9, 10';

    // Center bet tiles
    ['any7','anyCraps','field','craps2','craps3','craps12','yo11','hard4','hard6','hard8','hard10'].forEach(bt => {
        const tile = document.getElementById(bt + 'TileBtn');
        const info = document.getElementById(bt + 'Info');
        if (tile) {
            if (bets[bt] > 0) {
                tile.classList.add('has-bet');
                if (info) info.textContent = '$' + bets[bt];
            } else {
                tile.classList.remove('has-bet');
                if (info) info.textContent = '';
            }
        }
    });

    const fieldBoardBtn = document.getElementById('fieldBoardBtn');
    const fieldBoardInfo = document.getElementById('fieldBoardInfo');
    if (fieldBoardBtn && fieldBoardInfo) {
        if (bets.field > 0) {
            fieldBoardBtn.classList.add('has-bet');
            fieldBoardInfo.textContent = '$' + bets.field;
        } else {
            fieldBoardBtn.classList.remove('has-bet');
            fieldBoardInfo.textContent = 'One-roll bet';
        }
    }

    // Center info summary
    const centerBets = ['any7','anyCraps','craps2','craps3','craps12','yo11','hard4','hard6','hard8','hard10'];
    const activeCenters = centerBets.filter(b => bets[b] > 0);
    const centerTotal = centerBets.reduce((s, b) => s + bets[b], 0);
    const centerBoardBtn = document.getElementById('centerBoardBtn');
    if (centerBoardBtn) {
        centerBoardBtn.classList.toggle('has-bet', centerTotal > 0);
    }
    document.getElementById('centerInfo').textContent = activeCenters.length > 0
        ? activeCenters.length + ' bets \u2022 $' + centerTotal
        : 'Props & Hardways';

    // Active bets strip
    updateActiveBetsStrip();
    updateBoardChips();

    // Max odds button
    updateMaxOddsButton();
    updateRollButton();
}

function updateMainBetBtn(bt, btnId, infoId) {
    const btn = document.getElementById(btnId);
    const info = document.getElementById(infoId);
    if (bets[bt] > 0) {
        info.textContent = '$' + bets[bt];
        if (btn) btn.classList.add('has-bet');
    } else {
        info.textContent = 'Tap to bet';
        if (btn) btn.classList.remove('has-bet');
    }
    // Odds render as gold chips on the board (see updateBoardChips)
}

function formatChipAmount(amount) {
    return '$' + Number(amount || 0).toLocaleString();
}

function getChipStyle(amount, kind = 'base') {
    if (kind === 'odds') return { color: '#f4c96a', text: '#161b10' };
    if (kind === 'dont') return { color: '#1d4ed8', text: '#ffffff' };
    if (amount >= 100) return { color: '#111827', text: '#ffffff' };
    if (amount >= 50) return { color: '#f8fafc', text: '#111827' };
    if (amount >= 25) return { color: '#1d4ed8', text: '#ffffff' };
    return { color: '#b91c1c', text: '#ffffff' };
}

function buildChipPile(amount, style) {
    const pile = document.createElement('span');
    pile.className = 'chip-pile';
    const chipCount = Math.min(3, Math.max(1, Math.ceil(amount / 25)));
    for (let i = 0; i < chipCount; i++) {
        const chip = document.createElement('span');
        chip.className = 'casino-chip';
        chip.style.setProperty('--chip-color', style.color);
        chip.style.setProperty('--chip-text', style.text);
        chip.setAttribute('data-amount', i === chipCount - 1 ? formatChipAmount(amount) : '');
        pile.appendChild(chip);
    }
    return pile;
}

function addBoardChip(zoneId, amount, options = {}) {
    const zone = document.getElementById(zoneId);
    if (!zone || amount <= 0) return;

    const stack = document.createElement('span');
    stack.className = 'board-chip-stack';
    if (options.variant) stack.classList.add('stack-' + options.variant);
    stack.setAttribute('aria-hidden', 'true');

    stack.appendChild(buildChipPile(amount, getChipStyle(amount, options.kind)));

    if (options.odds > 0) {
        const oddsPile = buildChipPile(options.odds, getChipStyle(options.odds, 'odds'));
        oddsPile.classList.add('odds-pile');
        oddsPile.setAttribute('data-label', 'odds');
        stack.appendChild(oddsPile);
    }

    if (options.note) {
        const note = document.createElement('span');
        note.className = 'chip-note';
        note.textContent = options.note;
        stack.appendChild(note);
    }

    zone.appendChild(stack);
}

function updateBoardChips() {
    document.querySelectorAll('.board-chip-stack').forEach(chip => chip.remove());

    addBoardChip('passLineBtn', bets.passLine, { odds: oddsBets.passLine });
    addBoardChip('dontPassBtn', bets.dontPass, { odds: oddsBets.dontPass, kind: 'dont' });
    addBoardChip('fieldBoardBtn', bets.field);

    const centerKeys = ['any7','anyCraps','craps2','craps3','craps12','yo11','hard4','hard6','hard8','hard10'];
    const centerTotal = centerKeys.reduce((sum, key) => sum + bets[key], 0);
    const centerCount = centerKeys.filter(key => bets[key] > 0).length;
    addBoardChip('centerBoardBtn', centerTotal, { note: centerCount + ' bet' + (centerCount === 1 ? '' : 's') });

    [4, 5, 6, 8, 9, 10].forEach(num => {
        const zone = document.getElementById('boardPlace' + num + 'Btn');
        if (zone) zone.classList.toggle('point-on', point === num);

        addBoardChip('boardPlace' + num + 'Btn', bets['place' + num], { variant: 'place' });

        const comeAtPoint = comeBets.filter(bet => bet.point === num);
        comeAtPoint.forEach(bet => {
            addBoardChip('boardPlace' + num + 'Btn', bet.amount, {
                variant: 'come',
                odds: bet.odds,
                note: 'Come'
            });
        });

        const dontComeAtPoint = dontComeBets.filter(bet => bet.point === num);
        dontComeAtPoint.forEach(bet => {
            addBoardChip('boardPlace' + num + 'Btn', bet.amount, {
                variant: 'dont-come',
                kind: 'dont',
                odds: bet.odds,
                note: 'DC'
            });
        });
    });

    const waitingCome = comeBets
        .filter(bet => !bet.point)
        .reduce((sum, bet) => sum + bet.amount, 0);
    const waitingDontCome = dontComeBets
        .filter(bet => !bet.point)
        .reduce((sum, bet) => sum + bet.amount, 0);
    addBoardChip('comeBtn', waitingCome);
    addBoardChip('dontComeBtn', waitingDontCome, { kind: 'dont' });
}

function updateActiveBetsStrip() {
    const strip = document.getElementById('activeBetsStrip');
    strip.innerHTML = '';
    const allBetKeys = Object.keys(bets);
    allBetKeys.forEach(bt => {
        if (bets[bt] > 0) {
            const chip = document.createElement('div');
            chip.className = 'bet-chip';
            let text = betNames[bt] + ': $' + bets[bt];
            if (oddsBets[bt] > 0) text += ' +$' + oddsBets[bt];
            chip.append(document.createTextNode(text + ' '));
            if (canManageOdds(bt)) {
                const oddsButton = document.createElement('button');
                oddsButton.type = 'button';
                oddsButton.className = 'chip-odds';
                oddsButton.textContent = 'Odds';
                oddsButton.setAttribute('aria-label', 'Manage odds for ' + betNames[bt]);
                oddsButton.onclick = () => openOddsModal(bt);
                chip.appendChild(oddsButton);
            }
            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.className = 'chip-x';
            clearButton.textContent = '\u2715';
            clearButton.setAttribute('aria-label', 'Clear ' + betNames[bt]);
            clearButton.disabled = !canClearBet(bt);
            clearButton.onclick = () => clearBet(bt);
            chip.appendChild(clearButton);
            strip.appendChild(chip);
        }
    });
    // Come bets
    comeBets.forEach((bet, i) => {
        const chip = document.createElement('div');
        chip.className = 'bet-chip';
        let text = 'Come';
        if (bet.point) text += ' ' + bet.point;
        else text += ' (new)';
        text += ': $' + bet.amount;
        if (bet.odds > 0) text += ' +$' + bet.odds;
        chip.append(document.createTextNode(text + ' '));
        if (canManageOdds('come', bet.id)) {
            const oddsButton = document.createElement('button');
            oddsButton.type = 'button';
            oddsButton.className = 'chip-odds';
            oddsButton.textContent = 'Odds';
            oddsButton.setAttribute('aria-label', 'Manage odds for ' + text);
            oddsButton.onclick = () => openOddsModal('come', bet.id);
            chip.appendChild(oddsButton);
        }
        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.className = 'chip-x';
        clearButton.textContent = '\u2715';
        clearButton.setAttribute('aria-label', 'Clear ' + text);
        clearButton.disabled = !canClearComeBet(i, false);
        clearButton.onclick = () => clearComeBet(i, false);
        chip.appendChild(clearButton);
        strip.appendChild(chip);
    });
    // Don't Come bets
    dontComeBets.forEach((bet, i) => {
        const chip = document.createElement('div');
        chip.className = 'bet-chip';
        let text = "DC";
        if (bet.point) text += ' ' + bet.point;
        else text += ' (new)';
        text += ': $' + bet.amount;
        if (bet.odds > 0) text += ' +$' + bet.odds;
        chip.append(document.createTextNode(text + ' '));
        if (canManageOdds('dontCome', bet.id)) {
            const oddsButton = document.createElement('button');
            oddsButton.type = 'button';
            oddsButton.className = 'chip-odds';
            oddsButton.textContent = 'Odds';
            oddsButton.setAttribute('aria-label', 'Manage odds for ' + text);
            oddsButton.onclick = () => openOddsModal('dontCome', bet.id);
            chip.appendChild(oddsButton);
        }
        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.className = 'chip-x';
        clearButton.textContent = '\u2715';
        clearButton.setAttribute('aria-label', 'Clear ' + text);
        clearButton.disabled = !canClearComeBet(i, true);
        clearButton.onclick = () => clearComeBet(i, true);
        chip.appendChild(clearButton);
        strip.appendChild(chip);
    });
}

function updateMaxOddsButton() {
    const hasOddsTarget = (bets.passLine > 0 && point) ||
        (bets.dontPass > 0 && point) ||
        comeBets.some(b => b.point && b.amount > 0) ||
        dontComeBets.some(b => b.point && b.amount > 0);
    document.getElementById('maxOddsBtn').disabled = !hasOddsTarget || balance < 5;
}

function hasPendingPointPopup() {
    return pendingPointPopupSchedules > 0 ||
        pointPopupQueue.length > 0 ||
        document.getElementById('pointPopup').classList.contains('active');
}

function updateRollButton() {
    document.getElementById('rollButton').disabled = isRolling || hasPendingPointPopup();
}

// ── Roll Dice ──
function rollDice() {
    if (isRolling || hasPendingPointPopup()) return;
    const totalBets = Object.values(bets).reduce((a, b) => a + b, 0) +
        Object.values(oddsBets).reduce((a, b) => a + b, 0) +
        comeBets.reduce((s, b) => s + b.amount + b.odds, 0) +
        dontComeBets.reduce((s, b) => s + b.amount + b.odds, 0);
    if (totalBets === 0) {
        setStatus('Place a bet first!');
        return;
    }

    // Save for repeat
    lastBets = {
        bets: {...bets}, oddsBets: {...oddsBets},
        comeBets: comeBets.map(b => ({...b})),
        dontComeBets: dontComeBets.map(b => ({...b}))
    };
    document.getElementById('repeatBtn').disabled = false;

    isRolling = true;
    updateRollButton();
    setStatus('Rolling...');
    document.querySelector('.dice')?.classList.add('rolling');

    let rolls = 0;
    const interval = setInterval(() => {
        renderDie('die1', Math.floor(Math.random() * 6) + 1);
        renderDie('die2', Math.floor(Math.random() * 6) + 1);
        rolls++;
        if (rolls >= 12) { clearInterval(interval); finalizeRoll(); }
    }, 70);
}

function finalizeRoll() {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    renderDie('die1', d1);
    renderDie('die2', d2);
    document.querySelector('.dice')?.classList.remove('rolling');
    resolveRoll(d1, d2);
    isRolling = false;
    updateRollButton();
}

// ── Resolve All Bets ──
function resolveRoll(d1, d2) {
    const total = d1 + d2;
    const isHard = d1 === d2;
    const wasComeOutRoll = isComeOutRoll;
    let winnings = 0;
    let resolvedStake = 0;
    let messages = [];

    const oneRollResult = rules.resolveOneRollBets(bets, total);
    Object.assign(bets, oneRollResult.bets);
    winnings += oneRollResult.winnings;
    resolvedStake += oneRollResult.resolvedStake;
    messages.push(...oneRollResult.messages);

    const hardwayResult = rules.resolveHardwayBets(bets, total, isHard);
    Object.assign(bets, hardwayResult.bets);
    winnings += hardwayResult.winnings;
    resolvedStake += hardwayResult.resolvedStake;
    messages.push(...hardwayResult.messages);

    // ── Come Out Roll ──
    let justEstablishedPoint = false;
    if (isComeOutRoll) {
        if (total === 7 || total === 11) {
            if (bets.passLine > 0) { resolvedStake += bets.passLine + oddsBets.passLine; winnings += bets.passLine * 2; messages.push('Pass Line wins!'); }
            if (bets.dontPass > 0 || oddsBets.dontPass > 0) { resolvedStake += bets.dontPass + oddsBets.dontPass; }
            bets.dontPass = 0; oddsBets.dontPass = 0;
            messages.push('Natural!');
            resetPassLineRound();
        } else if ([2,3,12].includes(total)) {
            if (bets.dontPass > 0) {
                resolvedStake += bets.dontPass + oddsBets.dontPass;
                if (total !== 12) { winnings += bets.dontPass * 2; messages.push("Don't Pass wins!"); }
                else { winnings += bets.dontPass; messages.push("Don't Pass pushes on 12"); }
            }
            if (bets.passLine > 0 || oddsBets.passLine > 0) { resolvedStake += bets.passLine + oddsBets.passLine; }
            bets.passLine = 0; oddsBets.passLine = 0;
            messages.push('Craps!');
            resetPassLineRound();
        } else {
            point = total;
            isComeOutRoll = false;
            justEstablishedPoint = true;
            document.getElementById('pointDisplay').textContent = 'POINT: ' + point;
            messages.push('Point is ' + point);
            // Show point popup if there's a pass line or don't pass bet without odds
            if (bets.passLine > 0 && oddsBets.passLine === 0) {
                schedulePointPopup(point, 'passLine', null, 500);
            }
            if (bets.dontPass > 0 && oddsBets.dontPass === 0) {
                schedulePointPopup(point, 'dontPass', null, 600);
            }
        }
    }

    // ── Come Bets (resolve on every roll, independent of Pass Line) ──
    let comePopupDelay = 500;
    const comeBetsToRemove = [];
    comeBets.forEach((bet, i) => {
        if (!bet.point) {
            // Come bet "come out" roll
            if (total === 7 || total === 11) {
                resolvedStake += bet.amount + bet.odds;
                winnings += bet.amount * 2; messages.push('Come wins!');
                comeBetsToRemove.push(i);
            } else if ([2,3,12].includes(total)) {
                resolvedStake += bet.amount + bet.odds;
                messages.push('Come loses');
                comeBetsToRemove.push(i);
            } else {
                bet.point = total;
                messages.push('Come point: ' + total);
                // Show point popup for this come bet
                if (bet.odds === 0) {
                    const id = bet.id;
                    const pt = total;
                    schedulePointPopup(pt, 'come', id, comePopupDelay);
                    comePopupDelay += 100;
                }
            }
        } else {
            // Come bet point phase
            if (total === bet.point) {
                resolvedStake += bet.amount + bet.odds;
                winnings += bet.amount * 2;
                if (bet.odds > 0) {
                    if (wasComeOutRoll) {
                        winnings += bet.odds;
                        messages.push('Come ' + bet.point + ' wins! Odds returned.');
                    } else {
                        const ow = Math.floor(bet.odds * getOddsPayout(bet.point, true));
                        winnings += bet.odds + ow;
                        messages.push('Come ' + bet.point + ' wins +$' + (bet.amount + ow) + '!');
                    }
                } else {
                    messages.push('Come ' + bet.point + ' wins!');
                }
                comeBetsToRemove.push(i);
            } else if (total === 7) {
                resolvedStake += bet.amount + bet.odds;
                if (wasComeOutRoll && bet.odds > 0) {
                    winnings += bet.odds;
                    messages.push('Come ' + bet.point + ' loses; odds returned');
                }
                comeBetsToRemove.push(i);
            }
        }
    });
    // Remove resolved come bets (reverse order to preserve indices)
    for (let i = comeBetsToRemove.length - 1; i >= 0; i--) {
        comeBets.splice(comeBetsToRemove[i], 1);
    }

    // ── Don't Come Bets (resolve on every roll, independent of Pass Line) ──
    let dcPopupDelay = 600;
    const dontComeBetsToRemove = [];
    dontComeBets.forEach((bet, i) => {
        if (!bet.point) {
            // Don't Come bet "come out" roll
            if (total === 2 || total === 3) {
                resolvedStake += bet.amount + bet.odds;
                winnings += bet.amount * 2; messages.push("Don't Come wins!");
                dontComeBetsToRemove.push(i);
            } else if (total === 7 || total === 11) {
                resolvedStake += bet.amount + bet.odds;
                dontComeBetsToRemove.push(i);
            } else if (total === 12) {
                resolvedStake += bet.amount + bet.odds;
                winnings += bet.amount; messages.push("Don't Come pushes");
                dontComeBetsToRemove.push(i);
            } else {
                bet.point = total;
                messages.push("DC point: " + total);
                // Show point popup for this don't come bet
                if (bet.odds === 0) {
                    const id = bet.id;
                    const pt = total;
                    schedulePointPopup(pt, 'dontCome', id, dcPopupDelay);
                    dcPopupDelay += 100;
                }
            }
        } else {
            // Don't Come bet point phase
            if (total === 7) {
                resolvedStake += bet.amount + bet.odds;
                winnings += bet.amount * 2;
                if (bet.odds > 0) {
                    const ow = Math.floor(bet.odds * getOddsPayout(bet.point, false));
                    winnings += bet.odds + ow;
                    messages.push("DC " + bet.point + " wins +$" + (bet.amount + ow) + '!');
                } else {
                    messages.push("DC " + bet.point + " wins!");
                }
                dontComeBetsToRemove.push(i);
            } else if (total === bet.point) {
                resolvedStake += bet.amount + bet.odds;
                dontComeBetsToRemove.push(i);
            }
        }
    });
    // Remove resolved don't come bets
    for (let i = dontComeBetsToRemove.length - 1; i >= 0; i--) {
        dontComeBets.splice(dontComeBetsToRemove[i], 1);
    }

    // ── Point Phase (Pass Line only) ──
    // Skip if we just established the point this roll
    if (!isComeOutRoll && !justEstablishedPoint) {

        const placeWinResult = rules.resolvePlaceBetWins(bets, total);
        winnings += placeWinResult.winnings;
        messages.push(...placeWinResult.messages);

        // Pass/Don't Pass resolution
        if (total === point) {
            if (bets.passLine > 0) {
                resolvedStake += bets.passLine + oddsBets.passLine;
                winnings += bets.passLine * 2;
                if (oddsBets.passLine > 0) {
                    const ow = Math.floor(oddsBets.passLine * getOddsPayout(point, true));
                    winnings += oddsBets.passLine + ow;
                    messages.push('Pass Line wins +$' + (bets.passLine + ow) + '!');
                } else {
                    messages.push('Pass Line wins!');
                }
            }
            if (bets.dontPass > 0 || oddsBets.dontPass > 0) { resolvedStake += bets.dontPass + oddsBets.dontPass; }
            messages.push('Hit the point!');
            // Only clear Pass Line and Don't Pass, keep Come/Don't Come
            resetPassLineRound();
        } else if (total === 7) {
            if (bets.passLine > 0 || oddsBets.passLine > 0) { resolvedStake += bets.passLine + oddsBets.passLine; }
            if (bets.dontPass > 0) {
                resolvedStake += bets.dontPass + oddsBets.dontPass;
                winnings += bets.dontPass * 2;
                if (oddsBets.dontPass > 0) {
                    const ow = Math.floor(oddsBets.dontPass * getOddsPayout(point, false));
                    winnings += oddsBets.dontPass + ow;
                    messages.push("Don't Pass wins +$" + (bets.dontPass + ow) + '!');
                } else {
                    messages.push("Don't Pass wins!");
                }
            }
            messages.push('Seven out!');
            const placeSevenResult = rules.resolvePlaceBetsOnSeven(bets);
            Object.assign(bets, placeSevenResult.bets);
            resolvedStake += placeSevenResult.resolvedStake;
            resetRound();
        }
    }

    balance += winnings;
    updateBalance();
    updateAllDisplays();

    const statusMsg = messages.length > 0
        ? messages.join(' \u2022 ')
        : (isComeOutRoll ? 'Place bets & roll' : 'Rolled ' + total);
    setStatus(statusMsg);
    const netRoll = winnings - resolvedStake;
    showRollResultAnimation(netRoll);
    if (casinoProfile && resolvedStake > 0) {
        casinoProfile.recordSession('craps', {
            handsPlayed: 1,
            netProfit: netRoll,
            biggestWin: Math.max(0, netRoll)
        });
    }
    window.pgAnalytics?.track?.('craps_roll_resolved', {
        total,
        point,
        come_out: wasComeOutRoll,
        net: netRoll,
        balance,
    });
}

function resetPassLineRound() {
    clearPendingPointPopups();
    // Only clear Pass Line related bets, keep Come/Don't Come
    point = null;
    isComeOutRoll = true;
    document.getElementById('pointDisplay').textContent = '';

    // Clear only Pass Line and Don't Pass
    bets.passLine = 0; bets.dontPass = 0;
    oddsBets.passLine = 0; oddsBets.dontPass = 0;
}

function resetRound() {
    clearPendingPointPopups();
    point = null;
    isComeOutRoll = true;
    document.getElementById('pointDisplay').textContent = '';

    // Clear line bets
    bets.passLine = 0; bets.dontPass = 0;
    oddsBets.passLine = 0; oddsBets.dontPass = 0;

    // Clear come/don't come bets
    comeBets = [];
    dontComeBets = [];

    // Clear place bets
    bets.place4 = bets.place5 = bets.place6 = bets.place8 = bets.place9 = bets.place10 = 0;
}

// ── Point Popup ──
let pointPopupTimer = null;
let pointPopupQueue = []; // Queue of popups to show: { point, betType, betId }
let currentPopupBetType = 'passLine';
let currentPopupBetId = null; // Stable id into comeBets/dontComeBets arrays
let currentPopupPoint = null;
let pendingPointPopupSchedules = 0;
let pointPopupQueueTimer = null;

// Track scheduled popup timeouts so we can cancel them on close/reset and
// keep stale popups from firing after the user has moved on.
const pendingPointPopupTimers = new Set();

function schedulePointPopup(pt, betType = 'passLine', betId = null, delay = 0) {
    pendingPointPopupSchedules++;
    updateRollButton();
    let timer;
    timer = setTimeout(() => {
        if (timer !== undefined) pendingPointPopupTimers.delete(timer);
        pendingPointPopupSchedules--;
        showPointPopup(pt, betType, betId);
        updateRollButton();
    }, delay);
    pendingPointPopupTimers.add(timer);
}

function clearPendingPointPopups() {
    pendingPointPopupTimers.forEach((t) => clearTimeout(t));
    pendingPointPopupSchedules -= pendingPointPopupTimers.size;
    if (pendingPointPopupSchedules < 0) pendingPointPopupSchedules = 0;
    pendingPointPopupTimers.clear();
    if (pointPopupQueueTimer) {
        clearTimeout(pointPopupQueueTimer);
        pointPopupQueueTimer = null;
    }
    if (pointPopupTimer) {
        clearTimeout(pointPopupTimer);
        pointPopupTimer = null;
    }
    pointPopupQueue = [];
    document.getElementById('pointPopup')?.classList.remove('active');
}

function showPointPopup(pt, betType = 'passLine', betId = null) {
    // Queue the popup
    pointPopupQueue.push({ point: pt, betType: betType, betId: betId });
    updateRollButton();
    // If no popup is currently showing, show the next one
    const popup = document.getElementById('pointPopup');
    if (!popup.classList.contains('active')) {
        showNextPointPopup();
    }
}

function showNextPointPopup() {
    if (pointPopupQueue.length === 0) return;
    const next = pointPopupQueue.shift();

    const popup = document.getElementById('pointPopup');
    const pointNum = document.getElementById('popupPointNumber');
    const popupText = document.getElementById('popupText');
    const timerBar = document.getElementById('popupTimer');

    currentPopupBetType = next.betType;
    currentPopupBetId = next.betId;
    currentPopupPoint = next.point;
    pointNum.textContent = next.point;

    if (next.betType === 'come') {
        popupText.textContent = 'Take odds on your Come ' + next.point + ' bet?';
    } else if (next.betType === 'dontCome') {
        popupText.textContent = "Take lay odds on your DC " + next.point + " bet?";
    } else if (next.betType === 'dontPass') {
        popupText.textContent = "Take lay odds on your Don't Pass bet?";
    } else {
        popupText.textContent = 'Take odds on your Pass Line bet?';
    }

    timerBar.style.animation = 'none';
    timerBar.offsetHeight;
    timerBar.style.animation = 'timerCountdown 10s linear forwards';

    popup.classList.add('active');
    updateRollButton();

    if (pointPopupTimer) clearTimeout(pointPopupTimer);
    pointPopupTimer = setTimeout(() => {
        closePointPopup();
    }, 10000);
}

function closePointPopup() {
    const popup = document.getElementById('pointPopup');
    popup.classList.remove('active');
    if (pointPopupTimer) {
        clearTimeout(pointPopupTimer);
        pointPopupTimer = null;
    }
    // Show next popup in queue if any
    if (pointPopupQueue.length > 0) {
        if (pointPopupQueueTimer) clearTimeout(pointPopupQueueTimer);
        pointPopupQueueTimer = setTimeout(() => {
            pointPopupQueueTimer = null;
            showNextPointPopup();
        }, 300);
    }
    updateRollButton();
}

function takeOddsFromPopup(multiplier) {
    const betType = currentPopupBetType;
    const betId = currentPopupBetId;

    let targetBet;
    if (betType === 'come') {
        targetBet = comeBets.find(bet => bet.id === betId);
    } else if (betType === 'dontCome') {
        targetBet = dontComeBets.find(bet => bet.id === betId);
    } else {
        targetBet = { point: currentPopupPoint || point, amount: bets[betType], odds: oddsBets[betType] };
    }

    if (!targetBet || !targetBet.point || targetBet.amount === 0) {
        closePointPopup();
        return;
    }

    const isPass = betType === 'passLine' || betType === 'come';
    if (addOddsToBet(targetBet, multiplier, isPass)) {
        if (betType !== 'come' && betType !== 'dontCome') {
            oddsBets[betType] = targetBet.odds;
        }
        updateBalance();
        updateAllDisplays();
    }

    closePointPopup();
}

// ── Test Helpers ──
function __getGameState() {
    return {
        balance, point, isComeOutRoll,
        bets: { ...bets },
        oddsBets: { ...oddsBets },
        comeBets: comeBets.map(b => ({ ...b })),
        dontComeBets: dontComeBets.map(b => ({ ...b })),
        currentOddsTarget: currentOddsTarget ? { ...currentOddsTarget } : null,
        currentPopupBetType, currentPopupBetId,
        nextComeBetId,
    };
}

function __setGameState(state) {
    if ('balance' in state) balance = state.balance;
    if ('point' in state) point = state.point;
    if ('isComeOutRoll' in state) isComeOutRoll = state.isComeOutRoll;
    if ('bets' in state) Object.assign(bets, state.bets);
    if ('oddsBets' in state) Object.assign(oddsBets, state.oddsBets);
    if ('comeBets' in state) comeBets = state.comeBets.map(b => ({ ...b }));
    if ('dontComeBets' in state) dontComeBets = state.dontComeBets.map(b => ({ ...b }));
    if ('nextComeBetId' in state) nextComeBetId = state.nextComeBetId;
    if ('currentPopupBetType' in state) currentPopupBetType = state.currentPopupBetType;
    if ('currentPopupBetId' in state) currentPopupBetId = state.currentPopupBetId;
}

// ── Initialize ──
selectChip(selectedChip);
updateBalance();
updateAllDisplays();

// Tag every bet button with a native-tooltip explainer so desktop hover surfaces
// the rule + house edge without needing to open the modal.
document.querySelectorAll('[onclick*="openBetModal"], [onclick*="placeSelectedChip"]').forEach((btn) => {
    const onclick = btn.getAttribute('onclick') || '';
    const match = onclick.match(/(?:openBetModal|placeSelectedChip)\('([^']+)'\)/);
    if (!match) return;
    const info = BET_INFO[match[1]];
    if (!info) return;
    btn.setAttribute('title', `${info.rule}\n\nPays ${info.payout} · House edge ${info.edge}`);
});
