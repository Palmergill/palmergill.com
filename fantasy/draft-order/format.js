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

    function bustCopy(chance) {
        const value = Number(chance);
        if (!Number.isFinite(value) || value <= 0) return "Safe first flip";
        return `${value.toFixed(1)}% bust chance`;
    }

    function roomUrl(origin, roomId) {
        const url = new URL("/fantasy/draft-order/", origin);
        url.searchParams.set("room", roomId);
        return url.toString();
    }

    function roomModeName(mode) {
        if (mode === "practice") return "Practice";
        if (mode === "test") return "Bot test";
        return "Draft order game";
    }

    function botStepMessage(event) {
        if (!event) return "Bot turn complete.";
        if (event.outcome === "sealed") {
            return `${event.displayName} locked ${event.cardCount} card${event.cardCount === 1 ? "" : "s"} for the final reveal.`;
        }
        if (event.outcome === "busted") {
            return `${event.displayName} pulled ${cardLabel(event.card)} and busted round ${event.round}.`;
        }
        if (event.outcome === "banked") {
            return `${event.displayName} banked ${event.score} in round ${event.round}.`;
        }
        // A sealed final round hides the card itself, so count what they hold.
        if (!event.card) {
            return `${event.displayName} takes card ${event.cardCount}, face down.`;
        }
        return `${event.displayName} pulls ${cardLabel(event.card)}.`;
    }

    return { ordinal, cardLabel, compactHash, bustCopy, roomUrl, roomModeName, botStepMessage };
});
