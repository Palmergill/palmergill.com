const { createHash, webcrypto } = require('crypto');
const DraftOrderVerify = require('../draft-order/verify.js');

function cardPayload(code, deckIndex) {
    const rank = code.slice(0, -1);
    const suitCode = code.slice(-1);
    const suits = {
        C: ['clubs', '♣', false],
        D: ['diamonds', '♦', true],
        H: ['hearts', '♥', true],
        S: ['spades', '♠', false],
    };
    const ranks = { J: 11, Q: 12, K: 13, A: 14 };
    return {
        code,
        rank,
        suit: suits[suitCode][0],
        symbol: suits[suitCode][1],
        value: ranks[rank] || Number(rank),
        red: suits[suitCode][2],
        ...(deckIndex === undefined ? {} : { deckIndex }),
    };
}

async function validProof() {
    const masterSeed = '00'.repeat(32);
    const username = 'host-player';
    const deck = await DraftOrderVerify.deriveDeck(masterSeed, username, 1, webcrypto);
    const tieBreak = await DraftOrderVerify.seededTieBreak(masterSeed, username, webcrypto);
    const dealt = cardPayload(deck[0]);
    const score = dealt.value;
    return {
        game: 'fourth-and-fortune-v2',
        sessionId: 'proof-room',
        leagueName: 'Proof League',
        roundsPerPlayer: 1,
        masterSeed,
        publishedSeedHash: createHash('sha256').update(Buffer.from(masterSeed, 'hex')).digest('hex'),
        // This server-authored convenience flag is deliberately ignored.
        hashMatches: false,
        turnOrder: ['Host Player'],
        draftOrder: [{
            pick: 1,
            playerId: 'player-1',
            displayName: 'Host Player',
            score,
            bestRound: score,
        }],
        players: [{
            playerId: 'player-1',
            username,
            displayName: 'Host Player',
            turnPosition: 1,
            finalScore: score,
            tieBreakValue: tieBreak.toString(16).padStart(16, '0'),
            draws: [{ round: 1, deckIndex: 0, card: cardPayload(deck[0], 0) }],
            rounds: [{
                number: 1,
                cards: [dealt],
                cardCount: 1,
                score,
                busted: false,
                state: 'banked',
            }],
            decks: [{ round: 1, cards: deck.map((code, index) => cardPayload(code, index)) }],
        }],
    };
}

describe('DraftOrderVerify', () => {
    test('independently verifies the full result without trusting hashMatches', async () => {
        const result = await DraftOrderVerify.verifyProof(await validProof(), webcrypto);
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.computedDraftOrder[0].displayName).toBe('Host Player');
    });

    test('rejects a changed deck and a changed final order', async () => {
        const changedDeck = await validProof();
        changedDeck.players[0].decks[0].cards[0].code = 'AS';
        let result = await DraftOrderVerify.verifyProof(changedDeck, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes('full deck'))).toBe(true);

        const changedOrder = await validProof();
        changedOrder.draftOrder[0].score += 1;
        result = await DraftOrderVerify.verifyProof(changedOrder, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('Final draft order does not match the verified scores and tiebreaks.');
    });
});
