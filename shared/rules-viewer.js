(function () {
    function isDivider(line) {
        return /^\s*[=-]{8,}\s*$/.test(line);
    }

    function isSectionHeading(line) {
        const match = line.trim().match(/^(\d+)\.\s+(.+)$/);
        if (!match) return false;
        const heading = match[2];
        return heading === heading.toUpperCase() && /[A-Z]/.test(heading);
    }

    function isSubheading(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 54) return false;
        if (/^\d+\./.test(trimmed)) return false;
        if (/[:.()]$/.test(trimmed) && trimmed.split(/\s+/).length > 3) return false;
        return /^[A-Z0-9][A-Z0-9 /&.'"-]+$/.test(trimmed) && /[A-Z]/.test(trimmed);
    }

    function isBullet(line) {
        return /^\s*-\s+/.test(line);
    }

    function isNumberedItem(line) {
        return /^\s{2,}\d+\.\s+/.test(line);
    }

    function isTableLine(line) {
        if (!line.trim()) return false;
        if (isBullet(line) || isNumberedItem(line) || isSectionHeading(line)) return false;
        const trimmed = line.trim();
        if (/^-{3,}/.test(trimmed)) return true;
        if (/^\*{3,}/.test(trimmed)) return false;
        if (/\s{2,}/.test(line) && /(\d|%|:|->|---|HOUSE|EDGE|Dealer|Hand|Pair|TOTAL|BET)/.test(line)) return true;
        return false;
    }

    function appendParagraph(parent, text) {
        const p = document.createElement("p");
        p.textContent = text.replace(/\s+/g, " ").trim();
        parent.appendChild(p);
    }

    function appendList(parent, lines, ordered) {
        const list = document.createElement(ordered ? "ol" : "ul");
        let current = null;

        lines.forEach((line) => {
            const marker = ordered ? /^\s*\d+\.\s+/ : /^\s*-\s+/;
            if (marker.test(line)) {
                current = document.createElement("li");
                current.textContent = line.replace(marker, "").trim();
                list.appendChild(current);
            } else if (current) {
                current.textContent += " " + line.trim();
            }
        });

        parent.appendChild(list);
    }

    function appendPre(parent, lines) {
        const pre = document.createElement("pre");
        pre.textContent = lines.join("\n").replace(/\n{3,}/g, "\n\n");
        parent.appendChild(pre);
    }

    function createSection(title) {
        const section = document.createElement("section");
        section.className = "rules-section";
        if (title) {
            const h3 = document.createElement("h3");
            h3.textContent = title;
            section.appendChild(h3);
        }
        return section;
    }

    function formatRules(text, label) {
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const container = document.createElement("article");
        container.className = "rules-document";

        const firstTitleIndex = lines.findIndex((line) => line.trim() && !isDivider(line));
        const title = firstTitleIndex >= 0 ? lines[firstTitleIndex].trim().replace(/\s+/g, " ") : label;

        const header = document.createElement("header");
        const kicker = document.createElement("div");
        kicker.className = "rules-kicker";
        kicker.textContent = label || "Rules reference";
        const h2 = document.createElement("h2");
        h2.textContent = title;
        header.append(kicker, h2);
        container.appendChild(header);

        let section = createSection("Overview");
        container.appendChild(section);

        let i = firstTitleIndex + 1;
        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed || isDivider(line)) {
                i += 1;
                continue;
            }

            if (isSectionHeading(line)) {
                section = createSection(trimmed.replace(/^\d+\.\s+/, ""));
                container.appendChild(section);
                i += 1;
                continue;
            }

            if (isSubheading(line)) {
                const h3 = document.createElement("h3");
                h3.textContent = trimmed;
                section.appendChild(h3);
                i += 1;
                continue;
            }

            if (isBullet(line) || isNumberedItem(line)) {
                const ordered = isNumberedItem(line);
                const block = [];
                while (i < lines.length) {
                    const candidate = lines[i];
                    if (!candidate.trim()) break;
                    if (isDivider(candidate) || isSectionHeading(candidate)) break;
                    if (ordered && !isNumberedItem(candidate) && !/^\s{5,}\S/.test(candidate)) break;
                    if (!ordered && !isBullet(candidate) && !/^\s{4,}\S/.test(candidate)) break;
                    block.push(candidate);
                    i += 1;
                }
                appendList(section, block, ordered);
                continue;
            }

            if (isTableLine(line)) {
                const block = [];
                while (i < lines.length && lines[i].trim() && !isSectionHeading(lines[i]) && !isBullet(lines[i]) && !isNumberedItem(lines[i])) {
                    block.push(lines[i]);
                    i += 1;
                }
                appendPre(section, block);
                continue;
            }

            const paragraph = [trimmed];
            i += 1;
            while (i < lines.length) {
                const candidate = lines[i];
                if (!candidate.trim() || isDivider(candidate) || isSectionHeading(candidate) || isSubheading(candidate) || isBullet(candidate) || isNumberedItem(candidate) || isTableLine(candidate)) break;
                paragraph.push(candidate.trim());
                i += 1;
            }
            appendParagraph(section, paragraph.join(" "));
        }

        return container;
    }

    function initRulesApp(root) {
        const panel = root.querySelector("[data-rules-panel]");
        if (!panel) return;
        const content = panel.querySelector("[data-rules-content]") || panel;
        const source = panel.getAttribute("data-rules-source");
        const label = panel.getAttribute("data-rules-label") || "Rules reference";
        let loaded = false;

        function setSelected(name) {
            root.querySelectorAll("[data-rules-tab]").forEach((button) => {
                const selected = button.getAttribute("data-rules-tab") === name;
                button.setAttribute("aria-selected", selected ? "true" : "false");
            });
        }

        async function loadRules() {
            if (loaded || !source) return;
            content.replaceChildren();
            const loading = document.createElement("p");
            loading.className = "rules-loading";
            loading.textContent = "Loading rules...";
            content.appendChild(loading);

            try {
                const response = await fetch(source, { cache: "no-cache" });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                content.replaceChildren(formatRules(text, label));
                loaded = true;
            } catch {
                const message = document.createElement("p");
                message.className = "rules-error";
                message.textContent = "Rules could not be loaded. Try refreshing the page.";
                content.replaceChildren(message);
            }
        }

        function showRules() {
            root.classList.add("rules-visible");
            panel.hidden = false;
            setSelected("rules");
            loadRules();
            const heading = panel.querySelector("h1, h2");
            if (heading) heading.setAttribute("tabindex", "-1");
            requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
        }

        function showGame() {
            root.classList.remove("rules-visible");
            panel.hidden = true;
            setSelected("game");
        }

        root.querySelectorAll("[data-rules-open]").forEach((button) => {
            button.addEventListener("click", showRules);
        });
        root.querySelectorAll("[data-rules-close]").forEach((button) => {
            button.addEventListener("click", showGame);
        });
        root.querySelectorAll("[data-rules-tab]").forEach((button) => {
            button.addEventListener("click", () => {
                if (button.getAttribute("data-rules-tab") === "rules") showRules();
                else showGame();
            });
        });

        setSelected("game");
    }

    document.addEventListener("DOMContentLoaded", () => {
        document.querySelectorAll("[data-rules-app]").forEach(initRulesApp);
    });
})();
