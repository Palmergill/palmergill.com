(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.DraftOrderFormat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SUITS = {
        clubs: "♣",
        diamonds: "♦",
        hearts: "♥",
        spades: "♠",
    };

    function ordinal(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "—";
        const mod100 = number % 100;
        if (mod100 >= 11 && mod100 <= 13) return `${number}th`;
        const suffix = { 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th";
        return `${number}${suffix}`;
    }

    function cardLabel(card) {
        if (!card) return "";
        return `${card.rank || ""}${card.symbol || SUITS[card.suit] || ""}`;
    }

    function compactHash(value, visible) {
        const text = String(value || "");
        const size = Number.isInteger(visible) ? visible : 8;
        if (text.length <= size * 2 + 1) return text;
        return `${text.slice(0, size)}…${text.slice(-size)}`;
    }

    // The room sends no bust chance while a finished hand is held on the table:
    // a resolved round has no next flip to price. Number(null) is 0, so folding
    // that into the zero case read "Safe first flip" over the card that had
    // just busted somebody. Unknown and safe are different answers.
    function bustCopy(chance, cardsHeld) {
        if (chance === null || chance === undefined) return "—";
        const value = Number(chance);
        if (!Number.isFinite(value)) return "—";
        if (value <= 0) return cardsHeld ? "0.0% bust chance" : "Safe first flip";
        return `${value.toFixed(1)}% bust chance`;
    }

    function roomUrl(origin, roomId) {
        const url = new URL("/fantasy/draft-order/", origin);
        url.searchParams.set("room", roomId);
        return url.toString();
    }

    function verificationUrl(origin, roomId) {
        const url = new URL("/fantasy/draft-order/", origin);
        url.searchParams.set("verify", roomId);
        return url.toString();
    }

    function gameLengthCopy(managerCount, roundsPerPlayer) {
        const managers = Math.max(0, Number(managerCount) || 0);
        const rounds = Math.max(1, Number(roundsPerPlayer) || 5);
        const turns = managers * rounds;
        const lowMinutes = Math.max(1, Math.ceil(turns * 10 / 60));
        const highMinutes = Math.max(lowMinutes, Math.ceil(turns * 20 / 60));
        return `${turns} total turns · allow roughly ${lowMinutes}–${highMinutes} minutes.`;
    }

    function roomModeName(mode) {
        if (mode === "practice") return "Practice";
        if (mode === "test") return "Bot test";
        return "Draft order game";
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? "" : "s"}`;
    }

    // The room now publishes what just happened to everyone, not only to the
    // player who did it, so one narrator covers the actor, the spectators, and
    // the bots. Only the point of view changes.
    function turnEventMessage(event, options) {
        if (!event) return "";
        const isSelf = Boolean(options && options.isSelf);
        const who = event.displayName || "The current player";
        if (event.type === "forfeit") {
            return `${who} was skipped. Their remaining rounds score zero.`;
        }
        // A sealed final round hides the card itself, so count what they hold.
        if (event.sealed) {
            return event.turnComplete
                ? `${who} locked ${plural(event.cardCount, "card")} for the final reveal.`
                : `${who} takes card ${event.cardCount}, face down.`;
        }
        if (event.type === "bank") {
            // A multiplied round banks a raw card total that is not what lands
            // on the score, so say both numbers rather than leaving a manager to
            // wonder why the standings moved further than the line they read.
            const multiplier = Number(event.multiplier) || 1;
            if (multiplier > 1) {
                const worth = plural(event.score * multiplier, "point");
                return isSelf
                    ? `${event.score} banked at ${multiplier}× — ${worth}.`
                    : `${who} banked ${event.score} at ${multiplier}× — ${worth}.`;
            }
            return isSelf
                ? `${plural(event.score, "point")} banked.`
                : `${who} banked ${plural(event.score, "point")}.`;
        }
        if (event.busted) {
            return isSelf
                ? `${cardLabel(event.card)} repeats a rank. Round busted.`
                : `${cardLabel(event.card)} repeats a rank. ${who} busted.`;
        }
        return isSelf
            ? `${cardLabel(event.card)} dealt. Bank it or press again.`
            : `${who} pulls ${cardLabel(event.card)}.`;
    }

    function turnEventTone(event) {
        if (!event) return "";
        if (event.type === "forfeit") return "is-bust";
        if (event.sealed) return event.turnComplete ? "is-bank" : "";
        if (event.busted) return "is-bust";
        if (event.type === "bank") return "is-bank";
        return "";
    }

    return {
        ordinal,
        cardLabel,
        compactHash,
        bustCopy,
        roomUrl,
        verificationUrl,
        gameLengthCopy,
        roomModeName,
        turnEventMessage,
        turnEventTone,
    };
});
