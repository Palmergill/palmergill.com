/**
 * Regression test for a bankroll-clobber bug: applyAction() used to call
 * CasinoProfile.recordSession() (which synchronously notifies listeners,
 * including this page's own syncBalanceFromProfile) before persisting the
 * round's ending balance via CasinoProfile.setBankroll(). That re-entrant
 * notify read the stale pre-round bankroll and overwrote the just-computed
 * win, so a completed round always ended up debiting the bet regardless of
 * outcome. The fix persists the bankroll before recordSession() runs.
 */

const TABLE_MARKUP = `
<div id="casino-header-mount"></div>
<main class="blackjack-shell" data-rules-app>
  <header class="game-header">
    <div class="header-metrics">
      <strong id="shoeCount">312</strong>
      <button class="icon-button" id="newShoeButton" type="button"></button>
    </div>
  </header>
  <section class="session-stats">
    <strong id="statWins">0</strong>
    <strong id="statLosses">0</strong>
    <strong id="statPushes">0</strong>
    <strong id="statDealerBust">0%</strong>
    <div id="countTile" hidden><strong id="statHiLo">0</strong></div>
  </section>
  <section class="table">
    <button id="countToggleButton" type="button" aria-pressed="false">Show count</button>
    <button id="strategyToggleButton" type="button" aria-pressed="false">Strategy hint</button>
    <button id="resetButton" type="button">Reset bankroll</button>
    <strong id="dealerTotal"></strong>
    <div class="cards" id="dealerCards"></div>
    <div class="status-bar" id="statusText" role="status">Place your bet.</div>
    <strong id="activeHandLabel">Bet $25</strong>
    <strong id="balance">$1000</strong>
    <div class="hands" id="playerHands"></div>
  </section>
  <aside class="control-panel">
    <div class="betting-controls" id="bettingControls">
      <strong id="betAmount">$25</strong>
      <div class="chip-row">
        <button class="chip-button" type="button" data-chip="5">$5</button>
        <button class="chip-button" type="button" data-chip="25">$25</button>
        <button class="chip-button" type="button" data-chip="100">$100</button>
        <button class="chip-button" type="button" data-chip="500">$500</button>
      </div>
      <button id="betDownButton" type="button"></button>
      <button id="dealButton" type="button">Deal</button>
      <button id="betUpButton" type="button"></button>
    </div>
    <div class="insurance-controls" id="insuranceControls" hidden>
      <button id="insuranceButton" type="button">Insurance</button>
      <button id="declineInsuranceButton" type="button">No Insurance</button>
    </div>
    <div class="action-grid" id="actionControls">
      <button id="hitButton" type="button">Hit</button>
      <button id="standButton" type="button">Stand</button>
      <button id="doubleButton" type="button">Double</button>
      <button id="splitButton" type="button">Split</button>
    </div>
  </aside>
</main>
`;

function loadAppWithForcedBlackjack() {
    document.body.innerHTML = TABLE_MARKUP;

    jest.resetModules();
    localStorage.clear();

    const game = require("../blackjackGame");
    const C = game.createCard;

    // Force the very first round dealt to be a natural player blackjack
    // against a non-blackjack dealer hand, which resolves to "roundOver"
    // after a single startRound() call — deal order is player1, dealer1,
    // player2, dealer2.
    const filler = Array.from({ length: 60 }, () => C("2", "clubs"));
    const draws = [C("A", "spades"), C("5", "clubs"), C("K", "diamonds"), C("9", "clubs")];
    const forcedShoe = [...filler, ...[...draws].reverse()];
    const originalCreateState = game.createState;
    game.createState = (options = {}) =>
        originalCreateState({ ...options, shoe: [...forcedShoe] });

    window.BlackjackGame = game;
    require("../../shared/casino-profile.js");

    jest.isolateModules(() => {
        require("../app.js");
    });

    return { game };
}

describe("blackjack bankroll persistence ordering", () => {
    afterEach(() => {
        delete window.BlackjackGame;
        delete window.CasinoProfile;
        document.body.innerHTML = "";
    });

    test("a winning round credits the shared bankroll instead of debiting it", () => {
        loadAppWithForcedBlackjack();

        const startingBankroll = window.CasinoProfile.getBankroll();
        document.getElementById("dealButton").click();

        // Player blackjack pays 3:2 on a $25 bet: -25 stake, +62.5 payout = +37.5 net.
        const expectedBalance = startingBankroll + 37.5;

        expect(Number(document.getElementById("balance").textContent.replace(/[^0-9.]/g, "")))
            .toBeCloseTo(expectedBalance);
        expect(window.CasinoProfile.getBankroll()).toBeCloseTo(expectedBalance);
        expect(document.getElementById("statusText").textContent).not.toBe("Bankroll updated.");
    });
});
