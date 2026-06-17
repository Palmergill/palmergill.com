(function () {
    const notes = {
        rail: {
            label: "01 - Focus Table",
            copy: "A tighter mobile table that moves placed bets into large working tickets. Pass line and come bets share the same flat-plus-odds chip pair, so odds are obvious without tiny board overlays."
        },
        badges: {
            label: "02 - Bet Drawer",
            copy: "A bigger structural change: the board becomes compact and the placed bets live in a bottom drawer. It gives pass line and come odds more room and puts management targets near the thumb."
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
