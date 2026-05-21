const fs = require('fs');
const path = require('path');
const { TextDecoder, TextEncoder } = require('util');

global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const { JSDOM } = require('jsdom');

function loadGame() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/craps/',
  });
  const rulesScript = fs.readFileSync(path.join(__dirname, '..', 'crapsRules.js'), 'utf8');
  const appScript = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  dom.window.eval(rulesScript);
  dom.window.eval(appScript);
  return dom.window;
}

function readState(window) {
  const game = window.__getGameState();
  return {
    balance: game.balance,
    point: game.point,
    isComeOutRoll: game.isComeOutRoll,
    passLine: game.bets.passLine,
    passLineOdds: game.oddsBets.passLine,
    dontPassOdds: game.oddsBets.dontPass,
    place6: game.bets.place6,
    field: game.bets.field,
    comeBets: game.comeBets,
    dontComeBets: game.dontComeBets,
    currentOddsTarget: game.currentOddsTarget,
    currentPopupBetId: game.currentPopupBetId,
    status: window.document.getElementById('gameStatus').textContent,
    modalTitle: window.document.getElementById('modalTitle').textContent,
    modalInfo: window.document.getElementById('modalCurrentBet').textContent,
    rollDisabled: window.document.getElementById('rollButton').disabled,
    resultText: window.document.getElementById('rollResultBurst').textContent,
    resultClass: window.document.getElementById('rollResultBurst').className,
  };
}

describe('craps game regressions', () => {
  test("established Come and Don't Come bets survive pass-line come-out naturals", () => {
    const window = loadGame();
    window.__setGameState({
      balance: 970,
      point: null,
      isComeOutRoll: true,
      bets: { passLine: 10 },
      comeBets: [{ id: 1, point: 6, amount: 10, odds: 5 }],
      dontComeBets: [{ id: 2, point: 8, amount: 10, odds: 5 }],
      nextComeBetId: 3,
    });

    window.resolveRoll(3, 4);
    const state = readState(window);

    expect(state.balance).toBe(990);
    expect(state.point).toBeNull();
    expect(state.isComeOutRoll).toBe(true);
    expect(state.passLine).toBe(0);
    expect(state.comeBets).toEqual([{ id: 1, point: 6, amount: 10, odds: 5 }]);
    expect(state.dontComeBets).toEqual([{ id: 2, point: 8, amount: 10, odds: 5 }]);
  });

  test('point popup odds are capped at the remaining max odds', () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 6,
      isComeOutRoll: false,
      bets: { passLine: 10 },
      oddsBets: { passLine: 40 },
      currentPopupBetType: 'passLine',
      currentPopupBetId: null,
    });

    window.takeOddsFromPopup(3);
    const state = readState(window);

    expect(state.balance).toBe(990);
    expect(state.passLineOdds).toBe(50);
  });

  test('Come odds popup targets the same bet after earlier resolved bets are removed', () => {
    const window = loadGame();
    window.setTimeout = (fn) => {
      fn();
      return 1;
    };
    window.__setGameState({
      balance: 990,
      point: 8,
      isComeOutRoll: false,
      comeBets: [
        { id: 1, point: 6, amount: 5, odds: 0 },
        { id: 2, point: null, amount: 5, odds: 0 },
      ],
      nextComeBetId: 3,
    });

    window.resolveRoll(3, 3);
    expect(readState(window).currentPopupBetId).toBe(2);

    window.takeOddsFromPopup(1);
    const state = readState(window);

    expect(state.balance).toBe(995);
    expect(state.comeBets).toEqual([{ id: 2, point: 6, amount: 5, odds: 5 }]);
  });

  test('line odds popup uses the popup point even if the global point changes', () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 4,
      isComeOutRoll: false,
      bets: { passLine: 10 },
    });

    window.showPointPopup(4, 'passLine');
    window.__setGameState({ point: 6 });
    window.takeOddsFromPopup('max');
    const state = readState(window);

    expect(state.balance).toBe(970);
    expect(state.passLineOdds).toBe(30);
  });

  test('Pass Line odds can be added and removed after the point is established', () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 6,
      isComeOutRoll: false,
      bets: { passLine: 10 },
      oddsBets: { passLine: 10 },
    });

    window.openBetModal('passLine');
    expect(readState(window)).toMatchObject({
      modalTitle: 'Pass Line Odds',
      currentOddsTarget: { betType: 'passLine', betId: null },
    });

    window.document.getElementById('betInput').value = '15';
    window.addOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 985,
      passLineOdds: 25,
      status: 'Added $15 odds to Pass Line',
    });

    window.openBetModal('passLine');
    window.document.getElementById('betInput').value = '5';
    window.removeOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 990,
      passLineOdds: 20,
      status: 'Removed $5 odds from Pass Line',
    });
  });

  test("Don't Pass odds can be managed from the line button during a point", () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 8,
      isComeOutRoll: false,
      bets: { dontPass: 10 },
    });

    window.openBetModal('dontPass');
    expect(readState(window)).toMatchObject({
      modalTitle: "Don't Pass Odds",
      currentOddsTarget: { betType: 'dontPass', betId: null },
    });

    window.document.getElementById('betInput').value = '30';
    window.addOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 970,
      dontPassOdds: 30,
      status: "Added $30 odds to Don't Pass",
    });
  });

  test('established Come odds can be added and removed later', () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 8,
      isComeOutRoll: false,
      comeBets: [{ id: 4, point: 6, amount: 10, odds: 0 }],
      nextComeBetId: 5,
    });

    window.openOddsModal('come', 4);
    window.document.getElementById('betInput').value = '20';
    window.addOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 980,
      comeBets: [{ id: 4, point: 6, amount: 10, odds: 20 }],
      status: 'Added $20 odds to Come 6',
    });

    window.openOddsModal('come', 4);
    window.removeOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 1000,
      comeBets: [{ id: 4, point: 6, amount: 10, odds: 0 }],
      status: 'Removed $20 odds from Come 6',
    });
  });

  test("established Don't Come odds can be added and removed later", () => {
    const window = loadGame();
    window.__setGameState({
      balance: 1000,
      point: 8,
      isComeOutRoll: false,
      dontComeBets: [{ id: 7, point: 9, amount: 10, odds: 10 }],
      nextComeBetId: 8,
    });

    window.openOddsModal('dontCome', 7);
    window.document.getElementById('betInput').value = '15';
    window.addOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 985,
      dontComeBets: [{ id: 7, point: 9, amount: 10, odds: 25 }],
      status: 'Added $15 odds to DC 9',
    });

    window.openOddsModal('dontCome', 7);
    window.removeOddsFromModal();
    expect(readState(window)).toMatchObject({
      balance: 1010,
      dontComeBets: [{ id: 7, point: 9, amount: 10, odds: 0 }],
      status: 'Removed $25 odds from DC 9',
    });
  });

  test('roll button stays disabled while point popup is pending or open', () => {
    const window = loadGame();
    const callbacks = [];
    window.setTimeout = (fn) => {
      callbacks.push(fn);
      return callbacks.length;
    };

    window.schedulePointPopup(6, 'passLine', null, 500);
    expect(readState(window).rollDisabled).toBe(true);

    callbacks.shift()();
    expect(readState(window).rollDisabled).toBe(true);

    window.closePointPopup();
    expect(readState(window).rollDisabled).toBe(false);
  });

  test('contract Pass Line and established Come bets cannot be cleared', () => {
    const window = loadGame();
    window.__setGameState({
      balance: 975,
      point: 6,
      isComeOutRoll: false,
      bets: { passLine: 10, field: 5 },
      comeBets: [{ id: 1, point: 8, amount: 10, odds: 0 }],
    });

    window.clearAllBets();
    const state = readState(window);

    expect(state.balance).toBe(980);
    expect(state.passLine).toBe(10);
    expect(state.field).toBe(0);
    expect(state.comeBets).toEqual([{ id: 1, point: 8, amount: 10, odds: 0 }]);
  });

  test('place 6 bets require exact payout increments', () => {
    const window = loadGame();

    window.openBetModal('place6');
    window.document.getElementById('betInput').value = '5';
    window.confirmBet();
    expect(readState(window)).toMatchObject({
      balance: 1000,
      place6: 0,
      status: 'Minimum bet is $6',
    });

    window.document.getElementById('betInput').value = '6';
    window.confirmBet();
    expect(readState(window)).toMatchObject({
      balance: 994,
      place6: 6,
    });
  });

  test('primary table controls are native buttons', () => {
    const window = loadGame();

    expect(window.document.getElementById('passLineBtn').tagName).toBe('BUTTON');
    expect(window.document.getElementById('place6Btn').tagName).toBe('BUTTON');
    expect(window.document.getElementById('hard6TileBtn').tagName).toBe('BUTTON');
    expect(window.document.getElementById('comeBtn').disabled).toBe(true);
  });

  test('resolved losing bets show a loss animation', () => {
    const window = loadGame();
    window.__setGameState({ balance: 995, bets: { field: 5 } });

    window.resolveRoll(3, 3);
    const state = readState(window);

    expect(state.balance).toBe(995);
    expect(state.field).toBe(0);
    expect(state.resultText).toBe('-$5');
    expect(state.resultClass).toContain('loss');
    expect(state.resultClass).toContain('active');
  });

  test('winning rolls show a net win animation', () => {
    const window = loadGame();
    window.__setGameState({ balance: 990, bets: { passLine: 10 } });

    window.resolveRoll(3, 4);
    const state = readState(window);

    expect(state.balance).toBe(1010);
    expect(state.resultText).toBe('+$10');
    expect(state.resultClass).toContain('win');
    expect(state.resultClass).toContain('active');
  });

  test('pushes do not show a win or loss animation', () => {
    const window = loadGame();
    window.__setGameState({ balance: 990, bets: { dontPass: 10 } });

    window.resolveRoll(6, 6);
    const state = readState(window);

    expect(state.balance).toBe(1000);
    expect(state.resultText).toBe('');
    expect(state.resultClass).toBe('roll-result-burst');
  });
});

describe('shared nav dependencies', () => {
  test('shared nav uses local inline icons instead of a CDN dependency', () => {
    const navSource = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'site-nav.js'), 'utf8');

    expect(navSource).toContain('function iconSvg');
    expect(navSource).toContain('const icons = {');
    expect(navSource).not.toContain('lucide@');
    expect(navSource).not.toContain('lucide@latest');
  });
});
