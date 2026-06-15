(function () {
    const notes = {
        stage: {
            label: "01 · Center Stage",
            copy: "A clear vertical reading order for one-handed mobile play. Balance sits directly beneath your cards, while actions stay within thumb reach."
        },
        arc: {
            label: "02 · Table Arc",
            copy: "A more atmospheric casino layout. The cards follow the table curve and the balance becomes a compact satellite attached to your hand."
        },
        duel: {
            label: "03 · Head to Head",
            copy: "Dealer and player hands receive equal visual weight in two strong bays. The balance stays persistent in the header without competing with the cards."
        }
    };

    const stage = document.getElementById("previewStage");
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

    document.querySelectorAll("[data-device]").forEach((button) => {
        button.addEventListener("click", () => {
            const device = button.dataset.device;
            document.querySelectorAll("[data-device]").forEach((option) => {
                option.classList.toggle("is-active", option === button);
            });
            stage.classList.toggle("is-phone", device === "phone");
        });
    });
}());
