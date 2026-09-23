# Fantasy design, UI, and UX review — September 22, 2026

## Scope and method

Browser inspection at 1280×720 and 390×844. Reviewed the live signed-out home, market board (season and week), player drawer, rankings consensus entry, and draft-order landing. Reviewed the populated league hub, team page, weekly recap, and draft recap through a read-only localhost preview using a disposable copy of the existing local league database. Local data can differ from production. No production account settings or data were changed. The authenticated ranking editor and active multiplayer game were not exercised. This is a design review, not an exhaustive accessibility audit.

## Overall assessment

Keep the warm palette, restrained green accents, editorial typography, and generous separation between sections. The league hub is readable on desktop, and the player detail drawer groups related information well. The greatest opportunities concern mobile layout, consistent terminology, and making useful actions easier to reach. A new visual identity is unnecessary.

## 1. High priority: mobile market panels clip useful information

At 390px, Value Movers and Waiver Pulse remain side by side. Waiver Pulse then splits its own narrow space into Adds and Drops. Player names are clipped at the right edge. Top Offenses and Source Freshness also remain side by side; freshness dates wrap into narrow stacks. The page's document scroll width measured 477px against a 390px viewport.

The season table has a separate 470px-wide contents area in a 364px container. The initial mobile view shows Player and Implied Points, while the projection and difference—the purpose of the comparison—are off-screen without a clear swipe hint.

**Change:** stack `.insight-rail` and `.support-grid` on phones, allow children to shrink with `min-width: 0`, and simplify the mobile table to player, implied points, and difference. Put projection and source details in an expanded row, or provide a deliberate horizontal-scrolling treatment with a sticky player column and visible cue.

Relevant code: `fantasy/market/style.css` (`.insight-rail`, `.trending`, `.support-grid`, `.table-wrap`).

## 2. High priority: ranking and scoring labels appear contradictory

In the local team preview for 4th and 20, the narrative says “Power rank: #2 (composite score 0.662),” while the adjacent stats say “Power #10” and “Résumé #2.” These are different measures, but the narrative uses the same label as the other measure. Weekly recap cards also call the results-based ranking “Power.”

The narrative labels projected starter leaders PPR, while Start/sit uses Half PPR. A reader comparing the numbers has to reconcile different scoring systems within one team page.

**Change:** consistently use “Roster power” for forward-looking roster strength and “Results rank” or “Résumé rank” for earned results. Apply those names to stored narrative generation, recap cards, charts, and stats. Use the league's Half PPR scoring throughout team advice, with exceptions explicitly separated. Previously stored narratives need updating or a clear historical label as well.

## 3. Medium priority: weekly actions are too far down the team page

On the inspected mobile team page, Moves to consider starts around y=1,234, Start/sit around y=2,369, and the roster around y=2,808. Before reaching advice, the reader sees record and points in the masthead, again in the narrative, and again in the stats block. Trade suggestions then precede the more immediate lineup decision.

**Change:** put a compact current-week summary and actionable lineup moves directly below the team identity. Follow with waiver pickups, then trade ideas, roster, and deeper season context. Consolidate repeated record/points figures. Keep a short overview with expansion for the full narrative. Add section links if the long single-page format remains.

The newly added My team picker fixes the setup flow, but as permanent page furniture it sits abruptly against the masthead rule. Give unconfigured users a clear setup panel; show configured users their selected team and a small “Change” action.

## 4. Medium priority: mobile headers and controls delay the content

The mobile market page's first player starts around 710px down the page. Navigation, the large title, a separate week/freshness card, a second board heading, search, and several rows of controls consume most of the initial screen.

On Weekly Recap, 12 disabled future-week buttons wrap over several rows. They take more space than the two weeks the user can actually open. The separate Week 2 badge repeats the selected control.

**Change:** use a more compact mobile masthead, put week and freshness on one line, and group controls by purpose. Replace the recap's full future-week grid with previous/next controls and a week selector, or show only played weeks plus one upcoming marker. Keep the full season calendar behind a disclosure if it is useful.

## 5. Medium priority: the power chart is difficult to read early in the season

The chart allocates its width through week 14 even though only three weeks have points. The ten lines are compressed into the left portion, leaving most of the chart blank. The legend relies on color, and its line-highlighting behavior is implemented with mouseenter/mouseleave only. Touch and keyboard users cannot invoke that legend interaction.

**Change:** default to weeks with data, with a “Full season” option if preserving the full-season frame matters. Label line endpoints or provide a selected-team readout. Make legend entries buttons that support tap, keyboard activation, and an obvious selected state. Keep a table alternative for exact weekly ranks.

Relevant code: `fantasy/format.js:445`, `fantasy/app.js` (`renderChartLegend`).

## 6. Medium priority: freshness and movement labels overstate comparability

The live market page says “Latest market — as of Sep 22,” but the player drawer reports Kalshi at 19 days old alongside Polymarket from today. The Value Movers card says “7 DAYS” while its baseline is Sep 7, fifteen days before the review date. The details are present, but the prominent labels imply a freshness/window the underlying display does not consistently support.

**Change:** derive the movement-window label from the actual baseline. Distinguish “latest sync” from the age of contributing quotes. Put stale-source and incomplete-coverage indicators beside the affected values rather than relying on a separate source panel or hover explanation.

## 7. Medium priority: “Best possible” needs the same scoring basis as “Points”

The weekly recap table shows 4th and 20 with 144.8 Points but only 126.6 Best possible. A footnote explains that lineup efficiency excludes DST, but the adjacent column headings do not explain why the supposed maximum can be lower than the actual score.

**Change:** label the metric “Best lineup, excluding DST” and provide a matching “Started, excluding DST” number for comparison, or calculate/display both totals on the same basis. This is a presentation issue even when the underlying math is intentional.

## 8. Lower priority: related pages use different presentation conventions

The hub uses serif headings and largely borderless sections; market uses much larger serif headings and squared editorial cards; recap and rankings use sans-serif headings with rounded card containers. The shared colors and nav help, but the differences make the section feel assembled from separate designs.

**Change:** standardize content width, heading scale, card radius, control heights, metadata treatment, and vertical spacing across the league, market, rankings, and recap pages. The draft-order game's playful branding can remain distinct.

The rankings consensus empty state is honest but repeats the same absence twice, beneath copy promising a consensus starting point. Use one concise empty state and a relevant next step, such as creating a board or choosing a format known to contain published boards. Do not imply that an empty member consensus is an available starter list.

## Suggested order

1. Mobile overflow and clipped information.
2. Consistent rank/scoring language and comparable recap metrics.
3. Team-page action order and compact mobile headers.
4. Chart interaction and freshness labels.
5. Shared component/style polish.

No site code was changed as part of this review.


## Implementation — September 22, 2026

All eight review areas have been addressed in the local implementation:

- Mobile market panels stack, player metadata wraps, comparison actions remain visible, and the default season table keeps player, implied points, and difference in view. Detailed projections remain in the player drawer.
- Shared typography, content widths, focus treatment, and mobile navigation/spacing now apply across the analytical pages. The draft game keeps its own identity.
- Start/sit leads the team page. Season analysis is collapsible; a configured team shows a compact identity with a Change team action.
- The recap week controls show played weeks and one upcoming week, and its header is compact on mobile.
- Charts default to the available data range, retain an optional Full season view, support persistent button selection with a textual rank readout, and provide a weekly-rank table.
- Roster power and Results rank are named distinctly. New overview model inputs expose Half PPR projections only; legacy overview text is explicitly marked as archived with its ranking/scoring meaning explained.
- Value Movers labels the actual baseline date. Older source quotes are flagged beside the board, source ages are explicit, and latest collection is labeled Latest sync.
- Weekly recap now exposes and displays Started (no DST) beside Best lineup (no DST), leaving full ESPN game points separately labeled.
- Rankings no longer promise an available member consensus; the empty state provides next steps without duplicate absence messages.

Verification: 424 frontend tests passed across 17 suites; 155 targeted backend tests passed. Browser checks used a read-only local data copy: the mobile market and recap documents fit a 390px viewport without horizontal page overflow; market's first row moved from about 710px to 623px even with an older-source notice and the unconfigured member snapshot; start/sit moved into the first screen. Chart selection and full-width rendering were checked on mobile and at 1280px desktop width. Existing saved narratives were not regenerated or rewritten in the database. Deployment is not part of this implementation.
