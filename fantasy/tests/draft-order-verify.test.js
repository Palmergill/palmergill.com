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

// One manager, one card banked per round. The multiplier a proof is scored
// under comes from its game version, so the fixture takes the version and the
// round count and derives everything else the way a verifier has to.
async function proofFor(game, roundsPerPlayer) {
    const masterSeed = '00'.repeat(32);
    const username = 'host-player';
    const tieBreak = await DraftOrderVerify.seededTieBreak(masterSeed, username, webcrypto);
    const finalMultiplier = game === 'fourth-and-fortune-v3' ? 2 : 1;
    const decks = [];
    for (let round = 1; round <= roundsPerPlayer; round += 1) {
        decks.push(await DraftOrderVerify.deriveDeck(masterSeed, username, round, webcrypto));
    }
    const rawScores = decks.map((deck) => cardPayload(deck[0]).value);
    const score = rawScores.reduce((total, raw, index) => (
        total + raw * (index + 1 === roundsPerPlayer ? finalMultiplier : 1)
    ), 0);
    // Raw, deliberately: the multiplier never reaches the best-round tiebreak.
    const bestRound = Math.max(...rawScores);
    return {
        game,
        sessionId: 'proof-room',
        leagueName: 'Proof League',
        roundsPerPlayer,
        finalRoundMultiplier: finalMultiplier,
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
            bestRound,
        }],
        players: [{
            playerId: 'player-1',
            username,
            displayName: 'Host Player',
            turnPosition: 1,
            finalScore: score,
            tieBreakValue: tieBreak.toString(16).padStart(16, '0'),
            draws: decks.map((deck, index) => ({
                round: index + 1,
                deckIndex: 0,
                card: cardPayload(deck[0], 0),
            })),
            rounds: decks.map((deck, index) => ({
                number: index + 1,
                cards: [cardPayload(deck[0])],
                cardCount: 1,
                score: rawScores[index],
                multiplier: index + 1 === roundsPerPlayer ? finalMultiplier : 1,
                busted: false,
                state: 'banked',
            })),
            decks: decks.map((deck, index) => ({
                round: index + 1,
                cards: deck.map((code, cardIndex) => cardPayload(code, cardIndex)),
            })),
        }],
    };
}

async function validProof() {
    return proofFor('fourth-and-fortune-v2', 1);
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

    test('counts the last round double in the total and once in the tiebreak', async () => {
        const proof = await proofFor('fourth-and-fortune-v3', 2);
        const [firstRound, finalRound] = proof.players[0].rounds;
        // The fixture only proves the rule if the doubled last round would have
        // beaten the best raw round had the tiebreak counted it.
        expect(finalRound.score * 2).toBeGreaterThan(firstRound.score);

        const result = await DraftOrderVerify.verifyProof(proof, webcrypto);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.computedDraftOrder[0].score).toBe(firstRound.score + finalRound.score * 2);
        expect(result.computedDraftOrder[0].bestRound).toBe(firstRound.score);
    });

    test('rejects a v3 total that scored the last round flat', async () => {
        const flat = await proofFor('fourth-and-fortune-v3', 2);
        const rounds = flat.players[0].rounds;
        const flatTotal = rounds.reduce((total, round) => total + round.score, 0);
        flat.players[0].finalScore = flatTotal;
        flat.draftOrder[0].score = flatTotal;

        const result = await DraftOrderVerify.verifyProof(flat, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes('final score should be'))).toBe(true);
    });

    test('rejects a tiebreak that counted the doubled last round', async () => {
        const proof = await proofFor('fourth-and-fortune-v3', 2);
        const finalRound = proof.players[0].rounds[1];
        proof.draftOrder[0].bestRound = finalRound.score * 2;

        const result = await DraftOrderVerify.verifyProof(proof, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('Final draft order does not match the verified scores and tiebreaks.');
    });

    test('reads the multiplier off the game version, not the published field', async () => {
        const lying = await proofFor('fourth-and-fortune-v3', 2);
        lying.finalRoundMultiplier = 3;
        let result = await DraftOrderVerify.verifyProof(lying, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes('multiplier'))).toBe(true);

        // A version that never doubled cannot start doubling by declaring it.
        const flatVersion = await proofFor('fourth-and-fortune-v2', 2);
        flatVersion.finalRoundMultiplier = 2;
        flatVersion.players[0].finalScore += flatVersion.players[0].rounds[1].score;
        result = await DraftOrderVerify.verifyProof(flatVersion, webcrypto);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes('final score should be'))).toBe(true);
    });

    test('a version two room still scores every round at face value', async () => {
        const proof = await proofFor('fourth-and-fortune-v2', 2);
        const rounds = proof.players[0].rounds;
        const result = await DraftOrderVerify.verifyProof(proof, webcrypto);
        expect(result.errors).toEqual([]);
        expect(result.computedDraftOrder[0].score).toBe(rounds[0].score + rounds[1].score);
    });
});
