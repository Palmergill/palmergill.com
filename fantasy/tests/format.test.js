const FantasyFormat = require('../format.js');

describe('FantasyFormat', () => {
    test('positionLabel/positionQuery map DEF <-> DST', () => {
        expect(FantasyFormat.positionLabel('DEF')).toBe('DST');
        expect(FantasyFormat.positionLabel('WR')).toBe('WR');
        expect(FantasyFormat.positionQuery('DST')).toBe('DEF');
        expect(FantasyFormat.positionQuery('RB')).toBe('RB');
    });

    test('formatPoints renders one decimal and handles missing values', () => {
        expect(FantasyFormat.formatPoints(21)).toBe('21.0');
        expect(FantasyFormat.formatPoints(18.456)).toBe('18.5');
        expect(FantasyFormat.formatPoints(null)).toBe('—');
        expect(FantasyFormat.formatPoints('nope')).toBe('—');
    });

    test('ordinal handles teens and unit digits', () => {
        expect(FantasyFormat.ordinal(1)).toBe('1st');
        expect(FantasyFormat.ordinal(2)).toBe('2nd');
        expect(FantasyFormat.ordinal(3)).toBe('3rd');
        expect(FantasyFormat.ordinal(11)).toBe('11th');
        expect(FantasyFormat.ordinal(12)).toBe('12th');
        expect(FantasyFormat.ordinal(21)).toBe('21st');
        expect(FantasyFormat.ordinal(113)).toBe('113th');
    });

    test('rankDelta: lower rank number is an upward move', () => {
        // Was ranked 8th, now 3rd -> moved up 5.
        expect(FantasyFormat.rankDelta(8, 3)).toEqual({ direction: 'up', amount: 5 });
        // Was 3rd, now 8th -> moved down 5.
        expect(FantasyFormat.rankDelta(3, 8)).toEqual({ direction: 'down', amount: 5 });
        expect(FantasyFormat.rankDelta(4, 4)).toEqual({ direction: 'same', amount: 0 });
        expect(FantasyFormat.rankDelta(null, 4)).toBeNull();
    });

    test('sparkline scales points and reports endpoints', () => {
        const result = FantasyFormat.sparkline([10, 20, 15], 100, 40, 0);
        expect(result.first).toBe(10);
        expect(result.last).toBe(15);
        expect(result.min).toBe(10);
        expect(result.max).toBe(20);
        const coords = result.points.split(' ');
        expect(coords).toHaveLength(3);
        // First point sits at x=0; the max (20) sits at the top (y=0).
        expect(coords[0]).toBe('0,40');
        expect(coords[1]).toBe('50,0');
    });

    test('sparkline returns null for too-short series and centers flat ones', () => {
        expect(FantasyFormat.sparkline([5], 100, 40)).toBeNull();
        const flat = FantasyFormat.sparkline([7, 7, 7], 100, 40, 0);
        // All equal -> horizontal line through the middle.
        expect(flat.points).toBe('0,20 50,20 100,20');
    });

    test('americanOdds signs positive prices and dashes empties', () => {
        expect(FantasyFormat.americanOdds(150)).toBe('+150');
        expect(FantasyFormat.americanOdds(-110)).toBe('-110');
        expect(FantasyFormat.americanOdds(0)).toBe('—');
        expect(FantasyFormat.americanOdds(null)).toBe('—');
    });

    test('formatSpread signs the home line and calls 0 a pick-em', () => {
        expect(FantasyFormat.formatSpread(-3.5)).toBe('-3.5');
        expect(FantasyFormat.formatSpread(3.5)).toBe('+3.5');
        expect(FantasyFormat.formatSpread(0)).toBe('PK');
        expect(FantasyFormat.formatSpread(null)).toBe('—');
    });

    test('formatSigned shows movement with a sign', () => {
        expect(FantasyFormat.formatSigned(0.5, 1)).toBe('+0.5');
        expect(FantasyFormat.formatSigned(-1, 1)).toBe('-1');
        expect(FantasyFormat.formatSigned(0, 1)).toBe('0');
        expect(FantasyFormat.formatSigned(null)).toBe('');
    });

    test('formatArticleDate shows month/day, adding the year when not current', () => {
        const thisYear = new Date().getFullYear();
        expect(FantasyFormat.formatArticleDate(`${thisYear}-07-10T12:00:00Z`)).toMatch(/^Jul \d{1,2}$/);
        expect(FantasyFormat.formatArticleDate('2020-01-05T12:00:00Z')).toMatch(/^Jan \d{1,2}, 2020$/);
        expect(FantasyFormat.formatArticleDate('not-a-date')).toBe('');
        expect(FantasyFormat.formatArticleDate(null)).toBe('');
    });

    test('injuryBadge maps known statuses and shortens unknown ones', () => {
        expect(FantasyFormat.injuryBadge('Questionable')).toEqual({ code: 'Q', label: 'Questionable', severity: 'warn' });
        expect(FantasyFormat.injuryBadge('Out')).toEqual({ code: 'O', label: 'Out', severity: 'bad' });
        expect(FantasyFormat.injuryBadge('IR')).toEqual({ code: 'IR', label: 'IR', severity: 'bad' });
        expect(FantasyFormat.injuryBadge('Migraine')).toEqual({ code: 'MIG', label: 'Migraine', severity: 'warn' });
        expect(FantasyFormat.injuryBadge(null)).toBeNull();
        expect(FantasyFormat.injuryBadge('')).toBeNull();
    });

    test('formatMatchup renders home/away/bye', () => {
        expect(FantasyFormat.formatMatchup({ opponent: 'BUF', home: true })).toBe('vs BUF');
        expect(FantasyFormat.formatMatchup({ opponent: 'BUF', home: false })).toBe('@ BUF');
        expect(FantasyFormat.formatMatchup({ bye: true })).toBe('BYE');
        expect(FantasyFormat.formatMatchup({ opponent: null })).toBe('');
        expect(FantasyFormat.formatMatchup(null)).toBe('');
    });
});
