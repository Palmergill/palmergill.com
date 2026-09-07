/**
 * The `hidden` attribute has to actually hide things.
 *
 * A class that sets `display` outranks the UA stylesheet's `[hidden]` rule, so
 * an element toggled with `el.hidden = true` stays on screen while every DOM
 * test asserting `el.hidden === true` passes. It has bitten this repo twice:
 * `#shareLink` on the rankings board (`.button` is inline-flex) and the week
 * board's stepper (`.week-step` is inline-flex), the second caught only by
 * opening a browser.
 *
 * Every fantasy stylesheet therefore carries the guard `hidden` needs, and
 * this test is what keeps the next stylesheet from forgetting it.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SHEETS = [
    "fantasy/style.css",
    "fantasy/league/style.css",
    "fantasy/league/draft/style.css",
    "fantasy/rankings/style.css",
    "fantasy/draft-order/style.css",
];

const PAGES = [
    ["fantasy/index.html", "fantasy/style.css"],
    ["fantasy/league/index.html", "fantasy/league/style.css"],
    ["fantasy/league/draft/index.html", "fantasy/league/draft/style.css"],
    ["fantasy/rankings/index.html", "fantasy/rankings/style.css"],
    ["fantasy/draft-order/index.html", "fantasy/draft-order/style.css"],
];

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("hidden attribute guard", () => {
    test.each(SHEETS)("%s makes [hidden] win over display rules", (sheet) => {
        expect(read(sheet)).toContain("[hidden] { display: none !important; }");
    });

    test.each(PAGES)("%s hides everything it ships hidden", (page, sheet) => {
        const html = read(page);
        const css = read(sheet);
        const tags = html.match(/<[a-z][^>]*\shidden(\s|>|\/)[^>]*>/g) || [];
        expect(tags.length).toBeGreaterThan(0);

        const guarded = css.includes("[hidden] { display: none !important; }");
        // Either the sheet carries the blanket guard, or every hidden element's
        // own selectors must avoid setting display. The first is the rule here.
        expect(guarded).toBe(true);
    });
});
