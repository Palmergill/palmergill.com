(function () {
    const notes = {
        rail: {
            label: "01 - Rail Stack",
            copy: "Physical chip stacks stay on the board. The flat bet and odds bet are paired side by side, with gold reserved for odds so the pass line and come points read the same way."
        },
        badges: {
            label: "02 - Bet Badges",
            copy: "Each placed bet becomes a compact labeled badge. This is the most readable mobile option when multiple come bets are working at different numbers."
        },
        track: {
            label: "03 - Odds Track",
            copy: "The board stays cleaner by moving bet detail into a low odds track. Chips remain visible, but the user can scan every flat bet and odds bet in one thumb-zone list."
        }
    };

    const note = document.getElementById("conceptNote");

    document.querySelectorAll("[data-concept]").forEach((button) => {
        button.addEventListener("click", () => {
            const concept = button.dataset.concept;
            document.querySelectorAll("[data-concept]").forEach((tab) => {
                tab.classList.toggle("is-active", tab === button);
            });
            document.querySelectorAll("[data-concept-panel]").forEach((panel) => {
                panel.classList.toggle("is-active", panel.dataset.conceptPanel === concept);
            });
            note.innerHTML = `<span>${notes[concept].label}</span><p>${notes[concept].copy}</p>`;
        });
    });
}());
