// Gift board graph view (spec 21 P3). The same data as the board, drawn as
// inline SVG: you at the centre, your people evenly spaced on a ring, and each
// person's gifts fanned out on a short arc beyond them. Your own wishlist sits
// on an inner ring, in the gaps between the spokes.
//
// The layout is deterministic rather than force-directed, so the picture is
// the same on every visit and needs no physics loop or library.
(function () {
    "use strict";

    const SVG_NS = "http://www.w3.org/2000/svg";
    const ME_RADIUS = 34;
    const PERSON_RADIUS = 24;
    const ITEM_RADIUS = 7;
    const LABEL_MAX = 24;
    // Rough width of one label character at the graph's font size, for
    // sizing the viewBox so labels at the edge aren't clipped.
    const CHAR_WIDTH = 6.6;

    function svg(tag, attrs = {}, children = []) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) {
            if (value === null || value === undefined) continue;
            node.setAttribute(key, String(value));
        }
        for (const child of [].concat(children)) {
            if (child) node.append(child);
        }
        return node;
    }

    function truncate(text) {
        return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
    }

    function initials(name) {
        const parts = name.trim().split(/\s+/).filter(Boolean);
        const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
        return letters.toUpperCase();
    }

    function polar(radius, angle) {
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }

    // Pure layout: positions for every node, no DOM. Exposed for tests.
    function layout(people, items) {
        const n = people.length;
        const byPerson = new Map(people.map((person) => [person.id, []]));
        const mine = [];
        for (const item of items) {
            if (item.personId === null) mine.push(item);
            else if (byPerson.has(item.personId)) byPerson.get(item.personId).push(item);
        }

        const ringRadius = Math.max(230, n * 42);
        const slot = n ? (2 * Math.PI) / n : 2 * Math.PI;
        const nodes = [{ kind: "me", x: 0, y: 0, angle: 0 }];
        const edges = [];

        // Your wishlist: an inner ring, filling the gaps between spokes so no
        // gift sits on top of a line out to a person.
        const innerBase = n ? 118 : 130;
        mine.forEach((item, index) => {
            let angle;
            if (n) {
                const perGap = Math.ceil(mine.length / n);
                const gap = index % n;
                const within = Math.floor(index / n);
                angle = -Math.PI / 2 + gap * slot + (slot * (within + 1)) / (perGap + 1);
            } else {
                angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(mine.length, 1);
            }
            const radius = innerBase + (mine.length > 10 && index % 2 ? 46 : 0);
            const point = polar(radius, angle);
            nodes.push({ kind: "item", item, angle, ...point, mine: true });
            edges.push({ from: { x: 0, y: 0 }, to: point, mine: true });
        });

        people.forEach((person, index) => {
            const angle = -Math.PI / 2 + index * slot;
            const at = polar(ringRadius, angle);
            nodes.push({ kind: "person", person, angle, ...at });
            edges.push({ from: { x: 0, y: 0 }, to: at });

            const gifts = byPerson.get(person.id);
            const k = gifts.length;
            const spread = Math.min(slot * 0.82, k * 0.17);
            gifts.forEach((item, t) => {
                const itemAngle = k === 1 ? angle : angle - spread / 2 + (spread * t) / (k - 1);
                // Stagger long fans onto two radii so neighbouring labels clear.
                const radius = ringRadius + 104 + (k > 5 && t % 2 ? 58 : 0);
                const point = polar(radius, itemAngle);
                nodes.push({ kind: "item", item, angle: itemAngle, ...point });
                edges.push({ from: at, to: point });
            });
        });
        return { nodes, edges, ringRadius };
    }

    function labelAnchor(angle) {
        const cos = Math.cos(angle);
        if (cos > 0.2) return "start";
        if (cos < -0.2) return "end";
        return "middle";
    }

    function bounds(nodes) {
        let minX = -ME_RADIUS;
        let maxX = ME_RADIUS;
        let minY = -ME_RADIUS;
        let maxY = ME_RADIUS;
        for (const node of nodes) {
            let left = node.x - 30;
            let right = node.x + 30;
            if (node.kind === "item") {
                const width = truncate(node.item.title).length * CHAR_WIDTH + 14;
                const anchor = labelAnchor(node.angle);
                if (anchor === "start") right = node.x + width;
                else if (anchor === "end") left = node.x - width;
                else {
                    left = node.x - width / 2;
                    right = node.x + width / 2;
                }
            } else if (node.kind === "person") {
                const width = truncate(node.person.name).length * CHAR_WIDTH;
                left = Math.min(left, node.x - width / 2);
                right = Math.max(right, node.x + width / 2);
            }
            minX = Math.min(minX, left);
            maxX = Math.max(maxX, right);
            minY = Math.min(minY, node.y - 34);
            maxY = Math.max(maxY, node.y + 46);
        }
        const pad = 16;
        return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }

    function interactive(group, label, onActivate) {
        group.setAttribute("tabindex", "0");
        group.setAttribute("role", "button");
        group.setAttribute("aria-label", label);
        group.addEventListener("click", onActivate);
        group.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onActivate();
            }
        });
    }

    function render(container, { people, items, isDone, statusLabel, onItem, onPerson }) {
        const { nodes, edges } = layout(people, items);
        const box = bounds(nodes);
        const root = svg("svg", {
            class: "graph__svg",
            viewBox: `${box.x} ${box.y} ${box.width} ${box.height}`,
            role: "group",
            "aria-label": "Gift graph",
            // Natural size, so a big board scrolls inside the container on a
            // phone instead of shrinking to unreadable.
            style: `min-width: ${Math.min(box.width, 720)}px`,
        });

        const edgeLayer = svg("g", { class: "graph__edges", "aria-hidden": "true" });
        for (const edge of edges) {
            edgeLayer.append(svg("line", {
                x1: edge.from.x, y1: edge.from.y, x2: edge.to.x, y2: edge.to.y,
                class: edge.mine ? "graph__edge graph__edge--mine" : "graph__edge",
            }));
        }
        root.append(edgeLayer);

        const nodeLayer = svg("g", { class: "graph__nodes" });
        for (const node of nodes) {
            if (node.kind === "me") {
                nodeLayer.append(svg("g", { class: "graph__me", "aria-hidden": "true" }, [
                    svg("circle", { cx: 0, cy: 0, r: ME_RADIUS }),
                    svg("text", { x: 0, y: 5, "text-anchor": "middle" }, document.createTextNode("Me")),
                ]));
            } else if (node.kind === "person") {
                const { person } = node;
                const group = svg("g", { class: "graph__person", "data-person": person.id }, [
                    svg("title", {}, document.createTextNode(person.name)),
                    svg("circle", { cx: node.x, cy: node.y, r: PERSON_RADIUS }),
                    svg("text", { x: node.x, y: node.y + 5, "text-anchor": "middle", class: "graph__initials" },
                        document.createTextNode(initials(person.name))),
                    svg("text", { x: node.x, y: node.y + PERSON_RADIUS + 17, "text-anchor": "middle", class: "graph__label graph__label--person" },
                        document.createTextNode(truncate(person.name))),
                ]);
                interactive(group, `Edit ${person.name}`, () => onPerson(person.id));
                nodeLayer.append(group);
            } else {
                const { item } = node;
                const anchor = labelAnchor(node.angle);
                const dx = anchor === "start" ? 12 : anchor === "end" ? -12 : 0;
                const dy = anchor === "middle" ? (Math.sin(node.angle) > 0 ? 22 : -14) : 4;
                const classes = ["graph__item", `graph__item--${item.status}`];
                if (node.mine) classes.push("graph__item--mine");
                if (isDone(item)) classes.push("is-done");
                const group = svg("g", { class: classes.join(" "), "data-item": item.id }, [
                    svg("title", {}, document.createTextNode(`${item.title} · ${statusLabel(item.status)}`)),
                    // A bigger invisible target than the 7px dot, for fingers.
                    svg("circle", { cx: node.x, cy: node.y, r: 16, class: "graph__hit" }),
                    svg("circle", { cx: node.x, cy: node.y, r: ITEM_RADIUS, class: "graph__dot" }),
                    svg("text", { x: node.x + dx, y: node.y + dy, "text-anchor": anchor, class: "graph__label" },
                        document.createTextNode(truncate(item.title))),
                ]);
                interactive(group, `Edit ${item.title}`, () => onItem(item.id));
                nodeLayer.append(group);
            }
        }
        root.append(nodeLayer);

        // Centre on "Me" when the graph first appears in a narrow container,
        // but leave the scroll alone on redraws after an edit.
        const fresh = !container.firstChild;
        container.replaceChildren(root);
        if (fresh) {
            container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
        }
    }

    window.GiftGraph = { render, layout };
})();
