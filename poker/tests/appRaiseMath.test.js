/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

describe('poker app raise math', () => {
  beforeAll(() => {
    window.API_ORIGIN = '';
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    window.eval(source);
  });

  test('converts total slider commitment to backend raise size', () => {
    expect(window.PokerRaiseMath.calculateRaiseSizeForRequest(40, 20, 0)).toBe(20);
    expect(window.PokerRaiseMath.calculateRaiseSizeForRequest(75, 50, 25)).toBe(50);
    expect(window.PokerRaiseMath.calculateRaiseSizeForRequest(100, 0, 0)).toBe(100);
  });
});
