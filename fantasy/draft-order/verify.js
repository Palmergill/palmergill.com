(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.DraftOrderVerify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Both scoring rules are derived from the committed game version, never read
    // from the fields the proof publishes for them: a room that could name its
    // own multiplier could name the one that makes its totals add up.
    const FRESH_ROUND_DECK_VERSIONS = new Set(["fourth-and-fortune-v2", "fourth-and-fortune-v3"]);
    const DOUBLE_FINAL_ROUND_VERSIONS = new Set(["fourth-and-fortune-v3"]);
    const FINAL_ROUND_MULTIPLIER = 2;
    const RANKS = [...Array.from({ length: 9 }, (_, index) => String(index + 2)), "J", "Q", "K", "A"];
    const SUITS = ["C", "D", "H", "S"];
    const RANK_VALUES = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
    const UINT64_SPAN = 1n << 64n;

    function utf8(value) {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
        const encoded = unescape(encodeURIComponent(value));
        return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
    }

    function hexBytes(value) {
        if (!/^[0-9a-f]{64}$/.test(value)) {
            throw new Error("The master seed must be 64 lowercase hexadecimal characters.");
        }
        return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
    }

    function bytesHex(value) {
        return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    function counterBytes(counter) {
        const result = new Uint8Array(8);
        let remaining = counter;
        for (let index = 7; index >= 0; index -= 1) {
            result[index] = Number(remaining & 255n);
            remaining >>= 8n;
        }
        return result;
    }

    function firstUint64(value) {
        const bytes = new Uint8Array(value);
        let result = 0n;
        for (let index = 0; index < 8; index += 1) result = (result << 8n) | BigInt(bytes[index]);
        return result;
    }

    async function hmacKey(subtle, rawKey) {
        return subtle.importKey(
            "raw",
            rawKey,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
    }

    async function hmac(subtle, key, message) {
        return subtle.sign("HMAC", key, message);
    }

    function canonicalDeck() {
        return RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
    }

    async function shuffle(values, masterKey, context, subtle) {
        const contextDigest = await hmac(subtle, masterKey, utf8(context));
        const streamKey = await hmacKey(subtle, contextDigest);
        const result = [...values];
        let counter = 0n;
        for (let index = result.length - 1; index > 0; index -= 1) {
            const upper = BigInt(index + 1);
            const ceiling = UINT64_SPAN - (UINT64_SPAN % upper);
            let word;
            do {
                word = firstUint64(await hmac(subtle, streamKey, counterBytes(counter)));
                counter += 1n;
            } while (word >= ceiling);
            const swapIndex = Number(word % upper);
            [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
        }
        return result;
    }

    async function deriveDeck(seed, username, roundNumber, cryptoLike) {
        const subtle = cryptoLike?.subtle;
        if (!subtle) throw new Error("This browser does not provide Web Crypto.");
        const masterKey = await hmacKey(subtle, hexBytes(seed));
        const context = roundNumber == null
            ? `deck:v1:${username}`
            : `deck:v2:${username}:round:${roundNumber}`;
        return shuffle(canonicalDeck(), masterKey, context, subtle);
    }

    async function seededTieBreak(seed, username, cryptoLike) {
        const subtle = cryptoLike?.subtle;
        if (!subtle) throw new Error("This browser does not provide Web Crypto.");
        const masterKey = await hmacKey(subtle, hexBytes(seed));
        const digest = await hmac(subtle, masterKey, utf8(`tiebreak:v1:${username}`));
        return firstUint64(digest);
    }

    function sameList(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function roundScore(codes, state) {
        if (state === "forfeited" || state === "exhausted") return { score: 0, busted: false };
        const ranks = codes.map((code) => code.slice(0, -1));
        const busted = new Set(ranks).size !== ranks.length;
        const valid = codes.every((code) => Object.hasOwn(RANK_VALUES, code.slice(0, -1)) && SUITS.includes(code.slice(-1)));
        if (!valid) throw new Error("A round contains an invalid card.");
        return {
            score: busted ? 0 : ranks.reduce((total, rank) => total + RANK_VALUES[rank], 0),
            busted,
        };
    }

    async function verifyProof(proof, cryptoLike) {
        const errors = [];
        try {
            const subtle = cryptoLike?.subtle;
            if (!subtle) throw new Error("This browser does not provide Web Crypto.");
            const seed = String(proof?.masterSeed || "");
            const seedBytes = hexBytes(seed);
            const computedHash = bytesHex(await subtle.digest("SHA-256", seedBytes));
            if (computedHash !== proof?.publishedSeedHash) {
                errors.push("Published seed commitment does not match the revealed master seed.");
            }

            const players = Array.isArray(proof?.players) ? proof.players : [];
            if (!players.length) {
                errors.push("Proof contains no players.");
                return { ok: false, errors, computedHash, computedDraftOrder: [] };
            }
            const masterKey = await hmacKey(subtle, seedBytes);
            const usernames = players.map((player) => String(player.username || ""));
            if (new Set(usernames).size !== usernames.length || usernames.some((name) => !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name))) {
                errors.push("Proof contains an invalid or duplicate normalized account name.");
            }
            const expectedNames = await shuffle([...usernames].sort(), masterKey, "turn-order:v1", subtle);
            const playersByName = new Map(players.map((player) => [player.username, player]));
            const actualNames = [...players]
                .sort((left, right) => Number(left.turnPosition) - Number(right.turnPosition))
                .map((player) => player.username);
            if (!sameList(expectedNames, actualNames)) errors.push("Initial turn order does not match the committed seed.");
            const expectedDisplayOrder = expectedNames.map((name) => playersByName.get(name)?.displayName);
            if (!sameList(expectedDisplayOrder, Array.isArray(proof.turnOrder) ? proof.turnOrder : [])) {
                errors.push("Published turn-order labels do not match the committed order.");
            }

            const freshRoundDecks = FRESH_ROUND_DECK_VERSIONS.has(proof.game);
            const finalMultiplier = DOUBLE_FINAL_ROUND_VERSIONS.has(proof.game) ? FINAL_ROUND_MULTIPLIER : 1;
            if (proof.finalRoundMultiplier != null && Number(proof.finalRoundMultiplier) !== finalMultiplier) {
                errors.push(
                    `Proof claims a final-round multiplier of ${proof.finalRoundMultiplier}, `
                    + `but ${proof.game} scores it ${finalMultiplier}×.`,
                );
            }
            const roundsPerPlayer = Number(proof.roundsPerPlayer);
            if (!Number.isInteger(roundsPerPlayer) || roundsPerPlayer < 1) errors.push("Rounds-per-player is invalid.");
            const computedPlayers = [];

            for (const player of players) {
                const label = player.displayName || player.username || "Unknown player";
                const username = String(player.username || "");
                const tieDigest = await hmac(subtle, masterKey, utf8(`tiebreak:v1:${username}`));
                const tieBreak = firstUint64(tieDigest);
                if (tieBreak.toString(16).padStart(16, "0") !== player.tieBreakValue) {
                    errors.push(`${label}: seeded tie-break value is wrong.`);
                }

                const expectedDecks = new Map();
                if (freshRoundDecks) {
                    const deckRows = Array.isArray(player.decks) ? player.decks : [];
                    if (deckRows.length !== roundsPerPlayer) errors.push(`${label}: proof does not contain one full deck for every round.`);
                    for (let round = 1; round <= roundsPerPlayer; round += 1) {
                        const expected = await shuffle(canonicalDeck(), masterKey, `deck:v2:${username}:round:${round}`, subtle);
                        expectedDecks.set(round, expected);
                        const row = deckRows.find((candidate) => Number(candidate.round) === round);
                        const actual = Array.isArray(row?.cards) ? row.cards.map((card) => card.code) : [];
                        if (!sameList(expected, actual)) errors.push(`${label}: round ${round} full deck does not match the committed seed.`);
                    }
                } else {
                    const expected = await shuffle(canonicalDeck(), masterKey, `deck:v1:${username}`, subtle);
                    expectedDecks.set(0, expected);
                    const actual = Array.isArray(player.deck) ? player.deck.map((card) => card.code) : [];
                    if (!sameList(expected, actual)) errors.push(`${label}: full deck does not match the committed seed.`);
                }

                const draws = Array.isArray(player.draws) ? [...player.draws] : [];
                draws.sort(freshRoundDecks
                    ? (left, right) => Number(left.round) - Number(right.round) || Number(left.deckIndex) - Number(right.deckIndex)
                    : (left, right) => Number(left.deckIndex) - Number(right.deckIndex));
                const nextByRound = new Map();
                const dealtByRound = new Map();
                for (const draw of draws) {
                    const round = Number(draw.round);
                    const key = freshRoundDecks ? round : 0;
                    const expectedIndex = freshRoundDecks
                        ? (nextByRound.get(round) || 0)
                        : Array.from(nextByRound.values()).reduce((total, value) => total + value, 0);
                    const expectedDeck = expectedDecks.get(key) || [];
                    if (Number(draw.deckIndex) !== expectedIndex || draw.card?.code !== expectedDeck[expectedIndex]) {
                        errors.push(`${label}: round ${round} draw at deck index ${expectedIndex} does not match.`);
                    }
                    nextByRound.set(round, (nextByRound.get(round) || 0) + 1);
                    if (!dealtByRound.has(round)) dealtByRound.set(round, []);
                    dealtByRound.get(round).push(draw.card?.code);
                }

                const rounds = Array.isArray(player.rounds) ? player.rounds : [];
                const roundNumbers = rounds.map((round) => Number(round.number));
                const expectedRoundNumbers = Array.from({ length: roundsPerPlayer }, (_, index) => index + 1);
                if (!sameList([...roundNumbers].sort((a, b) => a - b), expectedRoundNumbers)) {
                    errors.push(`${label}: proof does not contain exactly one result for every round.`);
                }
                let finalScore = 0;
                let bestRound = 0;
                for (const round of rounds) {
                    const number = Number(round.number);
                    const cards = Array.isArray(round.cards) ? round.cards.map((card) => card.code) : [];
                    if (!sameList(cards, dealtByRound.get(number) || [])) {
                        errors.push(`${label}: round ${number} was scored on cards that were not dealt to this manager.`);
                    }
                    const expected = roundScore(cards, round.state);
                    if (Number(round.score) !== expected.score || Boolean(round.busted) !== expected.busted) {
                        errors.push(`${label}: round ${number} score or bust flag is wrong.`);
                    }
                    // Published round scores are always the raw card total. Only
                    // the running total takes the multiplier — the best-round
                    // tiebreak stays raw so a doubled last round cannot win it
                    // outright and stop separating level managers.
                    finalScore += expected.score * (number === roundsPerPlayer ? finalMultiplier : 1);
                    bestRound = Math.max(bestRound, expected.score);
                    dealtByRound.delete(number);
                }
                for (const omittedRound of dealtByRound.keys()) {
                    errors.push(`${label}: cards were dealt into round ${omittedRound}, which the proof omits.`);
                }
                if (Number(player.finalScore) !== finalScore) {
                    errors.push(`${label}: final score should be ${finalScore}, not ${player.finalScore}.`);
                }
                computedPlayers.push({
                    playerId: player.playerId,
                    displayName: player.displayName,
                    score: finalScore,
                    bestRound,
                    tieBreak,
                });
            }

            computedPlayers.sort((left, right) => (
                right.score - left.score
                || right.bestRound - left.bestRound
                || (right.tieBreak > left.tieBreak ? 1 : right.tieBreak < left.tieBreak ? -1 : 0)
            ));
            const computedDraftOrder = computedPlayers.map((player, index) => ({
                pick: index + 1,
                playerId: player.playerId,
                displayName: player.displayName,
                score: player.score,
                bestRound: player.bestRound,
            }));
            const publishedDraftOrder = Array.isArray(proof.draftOrder) ? proof.draftOrder : [];
            const finalMatches = computedDraftOrder.length === publishedDraftOrder.length
                && computedDraftOrder.every((entry, index) => {
                    const published = publishedDraftOrder[index];
                    return entry.pick === Number(published?.pick)
                        && entry.playerId === published?.playerId
                        && entry.displayName === published?.displayName
                        && entry.score === Number(published?.score)
                        && entry.bestRound === Number(published?.bestRound);
                });
            if (!finalMatches) errors.push("Final draft order does not match the verified scores and tiebreaks.");
            return { ok: errors.length === 0, errors, computedHash, computedDraftOrder };
        } catch (error) {
            errors.push(`Proof could not be checked: ${error.message || error}.`);
            return { ok: false, errors, computedHash: null, computedDraftOrder: [] };
        }
    }

    return { verifyProof, deriveDeck, seededTieBreak, canonicalDeck };
});
