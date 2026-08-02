const DraftOrderFormat = require('../draft-order/format.js');

describe('DraftOrderFormat', () => {
    test('ordinal handles normal and teen suffixes', () => {
        expect(DraftOrderFormat.ordinal(1)).toBe('1st');
        expect(DraftOrderFormat.ordinal(2)).toBe('2nd');
        expect(DraftOrderFormat.ordinal(3)).toBe('3rd');
        expect(DraftOrderFormat.ordinal(11)).toBe('11th');
        expect(DraftOrderFormat.ordinal(22)).toBe('22nd');
    });

    test('cardLabel uses the supplied rank and suit', () => {
        expect(DraftOrderFormat.cardLabel({ rank: 'A', symbol: '♠' })).toBe('A♠');
        expect(DraftOrderFormat.cardLabel({ rank: '10', suit: 'hearts' })).toBe('10♥');
    });

    test('compactHash preserves short values and abbreviates long ones', () => {
        expect(DraftOrderFormat.compactHash('abc')).toBe('abc');
        expect(DraftOrderFormat.compactHash('1234567890abcdef', 4)).toBe('1234…cdef');
    });

    test('bustCopy is clear for safe and risky flips', () => {
        expect(DraftOrderFormat.bustCopy(0)).toBe('Safe first flip');
        expect(DraftOrderFormat.bustCopy(12)).toBe('12.0% bust chance');
    });

    test('roomUrl creates a shareable same-site room link', () => {
        expect(DraftOrderFormat.roomUrl('https://palmergill.com', 'room-1')).toBe(
            'https://palmergill.com/fantasy/draft-order/?room=room-1'
        );
    });

    test('roomModeName keeps practice and bot tests distinct from league rooms', () => {
        expect(DraftOrderFormat.roomModeName('league')).toBe('Draft order game');
        expect(DraftOrderFormat.roomModeName('practice')).toBe('Practice');
        expect(DraftOrderFormat.roomModeName('test')).toBe('Bot test');
    });

    test('botRoundMessage reports both banked and busted bot rounds', () => {
        expect(DraftOrderFormat.botRoundMessage({
            displayName: 'Blitz Bot', round: 2, outcome: 'banked', score: 24,
        })).toBe('Blitz Bot banked 24 in round 2.');
        expect(DraftOrderFormat.botRoundMessage({
            displayName: 'Dime Bot', round: 1, outcome: 'busted', score: 0,
        })).toBe('Dime Bot busted round 1.');
        expect(DraftOrderFormat.botRoundMessage({
            displayName: 'Ace Bot', round: 3, outcome: 'sealed', cardCount: 4,
        })).toBe('Ace Bot locked 4 cards for the final reveal.');
    });
});
