const rules = require('../crapsRules');

describe('craps rules helpers', () => {
  test('uses full-payout units for place 6 and 8', () => {
    expect(rules.getBetUnit('passLine')).toBe(5);
    expect(rules.getBetUnit('place5')).toBe(5);
    expect(rules.getBetUnit('place6')).toBe(6);
    expect(rules.getBetUnit('place8')).toBe(6);
    expect(rules.getBetUnit('place9')).toBe(5);
  });

  test('validates minimums, increments, and balance', () => {
    expect(rules.validateBetAmount('passLine', 5, 100)).toBe('');
    expect(rules.validateBetAmount('passLine', 4, 100)).toBe('Minimum bet is $5');
    expect(rules.validateBetAmount('place6', 24, 100)).toBe('');
    expect(rules.validateBetAmount('place6', 25, 100)).toBe('Bet must be in $6 increments');
    expect(rules.validateBetAmount('passLine', 105, 100)).toBe('Not enough balance');
  });

  test('calculates pass and dont-pass odds payouts', () => {
    expect(rules.getOddsPayout(4, true)).toBe(2);
    expect(rules.getOddsPayout(5, true)).toBe(1.5);
    expect(rules.getOddsPayout(6, true)).toBe(1.2);
    expect(rules.getOddsPayout(4, false)).toBe(0.5);
    expect(rules.getOddsPayout(5, false)).toBe(2 / 3);
    expect(rules.getOddsPayout(6, false)).toBe(5 / 6);
  });

  test('caps odds additions by point max, existing odds, and balance', () => {
    expect(rules.getMaxOddsAmount(10, 4)).toBe(30);
    expect(rules.calculateOddsToAdd({ point: 4, amount: 10, odds: 0, balance: 100, multiplier: 'max' })).toBe(30);
    expect(rules.calculateOddsToAdd({ point: 4, amount: 10, odds: 20, balance: 100, multiplier: 'max' })).toBe(10);
    expect(rules.calculateOddsToAdd({ point: 4, amount: 10, odds: 0, balance: 12, multiplier: 'max' })).toBe(12);
    expect(rules.calculateOddsToAdd({ point: 4, amount: 10, odds: 28, balance: 100, multiplier: 'max' })).toBe(0);
  });

  test('resolves one-roll center bets and clears them', () => {
    const result = rules.resolveOneRollBets({
      any7: 5,
      anyCraps: 5,
      field: 10,
      craps2: 5,
      craps3: 5,
      craps12: 5,
      yo11: 5,
      passLine: 25
    }, 7);

    expect(result.winnings).toBe(25);
    expect(result.resolvedStake).toBe(40);
    expect(result.messages).toEqual(['Any 7 wins!']);
    expect(result.bets).toMatchObject({
      any7: 0,
      anyCraps: 0,
      field: 0,
      craps2: 0,
      craps3: 0,
      craps12: 0,
      yo11: 0,
      passLine: 25
    });
  });

  test('resolves field double and triple payouts', () => {
    expect(rules.resolveOneRollBets({ field: 10 }, 4)).toMatchObject({
      winnings: 20,
      resolvedStake: 10,
      messages: ['Field wins!']
    });
    expect(rules.resolveOneRollBets({ field: 10 }, 12)).toMatchObject({
      winnings: 30,
      resolvedStake: 10,
      messages: ['Field wins!']
    });
  });

  test('resolves hardways only on hard total, soft total, or seven', () => {
    const win = rules.resolveHardwayBets({ hard6: 5, hard8: 5 }, 6, true);
    expect(win).toMatchObject({
      winnings: 50,
      resolvedStake: 5,
      messages: ['Hard 6 wins!']
    });
    expect(win.bets.hard6).toBe(0);
    expect(win.bets.hard8).toBe(5);

    const lose = rules.resolveHardwayBets({ hard6: 5, hard8: 5 }, 6, false);
    expect(lose).toMatchObject({
      winnings: 0,
      resolvedStake: 5,
      messages: []
    });
    expect(lose.bets.hard6).toBe(0);
    expect(lose.bets.hard8).toBe(5);

    const sevenOut = rules.resolveHardwayBets({ hard4: 5, hard10: 5 }, 7, false);
    expect(sevenOut).toMatchObject({
      winnings: 0,
      resolvedStake: 10,
      messages: []
    });
    expect(sevenOut.bets.hard4).toBe(0);
    expect(sevenOut.bets.hard10).toBe(0);

    const comeOutSeven = rules.resolveHardwayBets({ hard4: 5, hard10: 5 }, 7, false, true);
    expect(comeOutSeven).toMatchObject({
      winnings: 0,
      resolvedStake: 0,
      messages: []
    });
    expect(comeOutSeven.bets.hard4).toBe(5);
    expect(comeOutSeven.bets.hard10).toBe(5);
  });

  test('pays place bets on their number without clearing them', () => {
    const result = rules.resolvePlaceBetWins({
      place4: 5,
      place5: 5,
      place6: 6,
      place8: 6,
      passLine: 25
    }, 6);

    expect(result.winnings).toBe(7);
    expect(result.resolvedStake).toBe(0);
    expect(result.messages).toEqual(['Place 6 wins!']);
    expect(result.bets.place6).toBe(6);
    expect(result.bets.passLine).toBe(25);
  });

  test('clears place bets on seven out and preserves other bets', () => {
    const result = rules.resolvePlaceBetsOnSeven({
      place4: 5,
      place5: 10,
      place6: 12,
      place8: 6,
      place9: 5,
      place10: 10,
      passLine: 25
    });

    expect(result.winnings).toBe(0);
    expect(result.resolvedStake).toBe(48);
    expect(result.messages).toEqual([]);
    expect(result.bets).toMatchObject({
      place4: 0,
      place5: 0,
      place6: 0,
      place8: 0,
      place9: 0,
      place10: 0,
      passLine: 25
    });
  });
});
