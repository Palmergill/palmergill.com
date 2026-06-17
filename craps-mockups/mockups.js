(function () {
    const notes = {
        rail: {
            label: "01 - Rail Table",
            copy: "Most faithful to a real table: pass stays on the outside rail, come bets sit on their point numbers, and the gold odds chip sits behind the flat chip instead of becoming text."
        },
        lanes: {
            label: "02 - Number Lanes",
            copy: "A portrait-native layout. The point numbers become large lanes with room for chips, while the pass line becomes a persistent bet card above the action buttons."
        },
        tray: {
            label: "03 - Dealer Tray",
            copy: "Best for managing several active bets. The table stays compact, and the bottom tray gives every Pass/Come bet a clear flat chip plus odds chip pair."
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
