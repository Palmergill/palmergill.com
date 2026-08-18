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

    test('bustCopy separates an unknown chance from a safe one', () => {
        // A held hand has no next flip to price, so the room sends null. That
        // used to read "Safe first flip" over the card that had just busted.
        expect(DraftOrderFormat.bustCopy(null, 4)).toBe('—');
        expect(DraftOrderFormat.bustCopy(undefined, 0)).toBe('—');
        expect(DraftOrderFormat.bustCopy(0, 3)).toBe('0.0% bust chance');
        expect(DraftOrderFormat.bustCopy(0, 0)).toBe('Safe first flip');
    });

    test('roomUrl creates a shareable same-site room link', () => {
        expect(DraftOrderFormat.roomUrl('https://palmergill.com', 'room-1')).toBe(
            'https://palmergill.com/fantasy/draft-order/?room=room-1'
        );
    });

    test('verificationUrl creates a public proof link instead of a member room link', () => {
        expect(DraftOrderFormat.verificationUrl('https://palmergill.com', 'room-1')).toBe(
            'https://palmergill.com/fantasy/draft-order/?verify=room-1'
        );
    });

    test('gameLengthCopy makes the sequential turn count and estimate visible', () => {
        expect(DraftOrderFormat.gameLengthCopy(16, 5)).toBe(
            '80 total turns · allow roughly 14–27 minutes.'
        );
    });

    test('roomModeName keeps practice, bot tables, and bot tests distinct from league rooms', () => {
        expect(DraftOrderFormat.roomModeName('league')).toBe('Draft order game');
        expect(DraftOrderFormat.roomModeName('practice')).toBe('Practice');
        expect(DraftOrderFormat.roomModeName('bots')).toBe('Bot table');
        expect(DraftOrderFormat.roomModeName('test')).toBe('Bot test');
    });

    test('centralDateTime treats API timestamps as UTC and displays Central time', () => {
        expect(DraftOrderFormat.centralDateTime('2026-07-10T01:30:00')).toBe(
            'Jul 9, 2026, 8:30 PM CDT'
        );
        expect(DraftOrderFormat.centralDateTime('2026-01-10T12:00:00Z')).toBe(
            'Jan 10, 2026, 6:00 AM CST'
        );
        expect(DraftOrderFormat.centralDateTime('not-a-date')).toBe('');
        expect(DraftOrderFormat.centralDateTime(null)).toBe('');
    });

    test('bestScoreContext says where a personal best was set', () => {
        expect(DraftOrderFormat.bestScoreContext(null)).toBe('');
        expect(DraftOrderFormat.bestScoreContext({
            mode: 'practice', score: 71, pick: 1, playerCount: 1,
        })).toBe('Set in a solo practice run.');
        expect(DraftOrderFormat.bestScoreContext({
            mode: 'bots', score: 88, pick: 1, playerCount: 4,
        })).toBe('1st of 4 against 3 bots.');
        expect(DraftOrderFormat.bestScoreContext({
            mode: 'league', score: 84, pick: 3, playerCount: 10, leagueName: 'Sunday Legends',
        })).toBe('3rd of 10 in Sunday Legends.');
        // A room whose final order could not be resolved still says something.
        expect(DraftOrderFormat.bestScoreContext({
            mode: 'bots', score: 60, pick: null, playerCount: 2,
        })).toBe('Set against 1 bot.');
    });

    test('turnEventMessage narrates a spectator view of each card, bank, and bust', () => {
        expect(DraftOrderFormat.turnEventMessage({
            type: 'flip', displayName: 'Blitz Bot', round: 2, card: { rank: '9', symbol: '♦' },
        })).toBe('Blitz Bot pulls 9♦.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Blitz Bot', round: 2, score: 24, turnComplete: true,
        })).toBe('Blitz Bot banked 24 points.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'flip', displayName: 'Dime Bot', round: 1, busted: true, turnComplete: true,
            card: { rank: 'K', symbol: '♣' },
        })).toBe('K♣ repeats a rank. Dime Bot busted.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'forfeit', displayName: 'Road Warrior', turnComplete: true,
        })).toBe('Road Warrior was skipped. Their remaining rounds score zero.');
    });

    test('turnEventMessage speaks to the player who acted', () => {
        const dealt = { type: 'flip', displayName: 'Palmer', card: { rank: '9', symbol: '♦' } };
        expect(DraftOrderFormat.turnEventMessage(dealt, { isSelf: true }))
            .toBe('9♦ dealt. Bank it or press again.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Palmer', score: 1, turnComplete: true,
        }, { isSelf: true })).toBe('1 point banked.');
    });

    test('turnEventMessage says what a multiplied bank is actually worth', () => {
        // The raw card total is not what lands on the score in the doubled last
        // round, so both numbers are spoken rather than leaving a manager to
        // wonder why the standings moved further than the line they just read.
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Blitz Bot', round: 5, score: 24, multiplier: 2,
            turnComplete: true,
        })).toBe('Blitz Bot banked 24 at 2× — 48 points.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Palmer', round: 5, score: 24, multiplier: 2,
            turnComplete: true,
        }, { isSelf: true })).toBe('24 banked at 2× — 48 points.');
        // A round that pays once still reads the plain way.
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Palmer', round: 3, score: 24, multiplier: 1,
            turnComplete: true,
        }, { isSelf: true })).toBe('24 points banked.');
    });

    test('turnEventMessage hides the card value in the sealed final round', () => {
        expect(DraftOrderFormat.turnEventMessage({
            type: 'flip', displayName: 'Ace Bot', round: 5, sealed: true, card: null, cardCount: 2,
        })).toBe('Ace Bot takes card 2, face down.');
        expect(DraftOrderFormat.turnEventMessage({
            type: 'bank', displayName: 'Ace Bot', round: 5, sealed: true, cardCount: 4,
            turnComplete: true,
        })).toBe('Ace Bot locked 4 cards for the final reveal.');
    });

    test('turnEventTone flags busts and banks for the message styling', () => {
        expect(DraftOrderFormat.turnEventTone(null)).toBe('');
        expect(DraftOrderFormat.turnEventTone({ type: 'flip' })).toBe('');
        expect(DraftOrderFormat.turnEventTone({ type: 'flip', busted: true })).toBe('is-bust');
        expect(DraftOrderFormat.turnEventTone({ type: 'bank' })).toBe('is-bank');
        expect(DraftOrderFormat.turnEventTone({ type: 'forfeit' })).toBe('is-bust');
        expect(DraftOrderFormat.turnEventTone({ type: 'flip', sealed: true })).toBe('');
    });
});
