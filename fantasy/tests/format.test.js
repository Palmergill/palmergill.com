const FantasyFormat = require('../format.js');

describe('FantasyFormat', () => {
    test('positionLabel/positionQuery map DEF <-> DST', () => {
        expect(FantasyFormat.positionLabel('DEF')).toBe('DST');
        expect(FantasyFormat.positionLabel('WR')).toBe('WR');
        expect(FantasyFormat.positionQuery('DST')).toBe('DEF');
        expect(FantasyFormat.positionQuery('RB')).toBe('RB');
    });

    test('seasonPositionCounts orders by depth chart and counts each position', () => {
        const leaders = [
            { player: { position: 'WR' } },
            { player: { position: 'QB' } },
            { player: { position: 'WR' } },
            { player: { position: 'RB' } },
        ];
        expect(FantasyFormat.seasonPositionCounts(leaders)).toEqual([
            { position: 'QB', count: 1 },
            { position: 'RB', count: 1 },
            { position: 'WR', count: 2 },
        ]);
    });

    test('seasonPositionCounts skips rows with no position and sorts unknowns last', () => {
        const leaders = [
            { player: { position: 'fb' } },
            { player: {} },
            {},
            { player: { position: 'QB' } },
            { player: { position: 'DST' } },
        ];
        expect(FantasyFormat.seasonPositionCounts(leaders)).toEqual([
            { position: 'QB', count: 1 },
            { position: 'DST', count: 1 },
            { position: 'FB', count: 1 },
        ]);
        expect(FantasyFormat.seasonPositionCounts([])).toEqual([]);
        expect(FantasyFormat.seasonPositionCounts(undefined)).toEqual([]);
    });

    test('seasonPairDetail names the scored categories and the dropped one', () => {
        expect(FantasyFormat.seasonPairDetail(['passing', 'rushing'], [], [])).toEqual({
            scored: 'passing + rushing',
            missing: '',
        });
        expect(FantasyFormat.seasonPairDetail(['passing'], ['rushing'], [])).toEqual({
            scored: 'passing',
            missing: 'rushing not fully quoted',
        });
        expect(FantasyFormat.seasonPairDetail(['receiving'], ['passing', 'rushing'], [])).toEqual({
            scored: 'receiving',
            missing: 'passing and rushing not fully quoted',
        });
        expect(FantasyFormat.seasonPairDetail(undefined, undefined, undefined)).toEqual({
            scored: '',
            missing: '',
        });
    });

    test('seasonPairDetail separates a category with no market from a half-quoted one', () => {
        // The case that used to render nothing at all: a back scored on
        // rushing whose receiving line was never posted.
        expect(FantasyFormat.seasonPairDetail(['rushing'], [], ['receiving'])).toEqual({
            scored: 'rushing',
            missing: 'no receiving market',
        });
        // "Said nothing" and "said something we could not use" are different
        // claims about the market and are not collapsed into one phrase.
        expect(FantasyFormat.seasonPairDetail(['passing'], ['receiving'], ['rushing'])).toEqual({
            scored: 'passing',
            missing: 'no rushing market · receiving not fully quoted',
        });
        expect(FantasyFormat.seasonPairDetail(['passing'], [], ['rushing', 'receiving'])).toEqual({
            scored: 'passing',
            missing: 'no rushing or receiving market',
        });
    });

    test('seasonPositionMatches treats ALL and missing filters as no filter', () => {
        const rb = { player: { position: 'RB' } };
        expect(FantasyFormat.seasonPositionMatches(rb, 'RB')).toBe(true);
        expect(FantasyFormat.seasonPositionMatches(rb, 'WR')).toBe(false);
        expect(FantasyFormat.seasonPositionMatches(rb, 'ALL')).toBe(true);
        expect(FantasyFormat.seasonPositionMatches(rb, null)).toBe(true);
        expect(FantasyFormat.seasonPositionMatches({}, 'RB')).toBe(false);
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

    test('seasonLine keeps the half point and separates thousands', () => {
        expect(FantasyFormat.seasonLine(999.5)).toBe('999.5');
        expect(FantasyFormat.seasonLine(3499.5)).toBe('3,499.5');
        expect(FantasyFormat.seasonLine(13.5)).toBe('13.5');
        // A whole-number threshold should not grow a bogus ".0".
        expect(FantasyFormat.seasonLine(12)).toBe('12');
        expect(FantasyFormat.seasonLine(null)).toBe('—');
        expect(FantasyFormat.seasonLine(undefined)).toBe('—');
    });

    test('impliedChance reads a quote as a whole percent', () => {
        expect(FantasyFormat.impliedChance(0.735)).toBe('74%');
        expect(FantasyFormat.impliedChance(0.11)).toBe('11%');
        expect(FantasyFormat.impliedChance(0)).toBe('0%');
        expect(FantasyFormat.impliedChance(null)).toBe('—');
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
    test('formatAsOf renders a UTC-marked collector timestamp', () => {
        // Server-marked UTC: the label must reflect the instant, not the
        // string's digits read as local time.
        expect(FantasyFormat.formatAsOf('2026-07-10T15:30:00Z')).toBe('as of Jul 10');
        expect(FantasyFormat.formatAsOf(null)).toBe('');
        expect(FantasyFormat.formatAsOf('')).toBe('');
        expect(FantasyFormat.formatAsOf('not a date')).toBe('');
    });

    test('quoteAge measures how long ago a provider last moved a price', () => {
        const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
        expect(FantasyFormat.quoteAge(days(0))).toBe('today');
        expect(FantasyFormat.quoteAge(days(1))).toBe('1 day ago');
        expect(FantasyFormat.quoteAge(days(11))).toBe('11 days ago');
        expect(FantasyFormat.quoteAge(null)).toBe('');
        expect(FantasyFormat.quoteAge('not a date')).toBe('');
    });

    test('marketSources names each provider beside its own age', () => {
        // The providers go stale at very different rates, so one combined
        // timestamp would hide whichever source is actually current.
        const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
        expect(FantasyFormat.marketSources([
            { bookmaker: 'Kalshi', quoted_at: days(11) },
            { bookmaker: 'Polymarket', quoted_at: days(0) },
        ])).toBe('Kalshi (11 days ago) · Polymarket (today)');
        // A provider that never reported a quote time is still named.
        expect(FantasyFormat.marketSources([{ bookmaker: 'Underdog', quoted_at: null }]))
            .toBe('Underdog');
        expect(FantasyFormat.marketSources([])).toBe('');
        expect(FantasyFormat.marketSources(null)).toBe('');
    });
});
