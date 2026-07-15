// Fantasy chat panel. Posts to /api/fantasy/chat and renders replies with a
// small Markdown-ish renderer (bold, bullets, line breaks). The session id is
// carried by an HttpOnly cookie the browser attaches automatically.
(function () {
    "use strict";

    const API_BASE = `${window.API_ORIGIN || ""}/api/fantasy`;

    const els = {
        messages: document.getElementById("chatMessages"),
        starts: document.getElementById("chatStarts"),
        form: document.getElementById("chatForm"),
        input: document.getElementById("chatInput"),
    };
    if (!els.form) return;

    let pending = false;

    async function fetchJson(url, options = {}) {
        const response = await fetch(url, { credentials: "include", ...options });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.detail || `Request failed with ${response.status}`);
        }
        return response.json();
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // Minimal, safe Markdown: escapes text, then renders **bold**, bullet
    // lists ("- "), and paragraph/line breaks. No raw HTML from the model.
    function renderMarkdown(container, text) {
        const blocks = String(text).split(/\n{2,}/);
        blocks.forEach((block) => {
            const lines = block.split("\n");
            const isList = lines.every((l) => l.trim().startsWith("- ") || l.trim() === "");
            if (isList) {
                const ul = el("ul", "chat-list");
                lines.filter((l) => l.trim().startsWith("- ")).forEach((l) => {
                    const li = el("li");
                    appendInline(li, l.trim().slice(2));
                    ul.appendChild(li);
                });
                container.appendChild(ul);
            } else {
                const p = el("p", "chat-para");
                lines.forEach((line, i) => {
                    if (i > 0) p.appendChild(document.createElement("br"));
                    appendInline(p, line);
                });
                container.appendChild(p);
            }
        });
    }

    function appendInline(parent, text) {
        // Split on **bold** spans; everything is inserted as text nodes so no
        // markup from the response is interpreted as HTML.
        const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
        parts.forEach((part) => {
            if (/^\*\*[^*]+\*\*$/.test(part)) {
                parent.appendChild(el("strong", null, part.slice(2, -2)));
            } else if (part) {
                parent.appendChild(document.createTextNode(part));
            }
        });
    }

    function addMessage(role, text, isMarkdown) {
        if (els.starts) els.starts.hidden = true;
        const wrap = el("div", `chat-msg chat-msg--${role}`);
        const bubble = el("div", "chat-bubble");
        if (isMarkdown) {
            renderMarkdown(bubble, text);
        } else {
            bubble.appendChild(document.createTextNode(text));
        }
        wrap.appendChild(bubble);
        els.messages.appendChild(wrap);
        els.messages.scrollTop = els.messages.scrollHeight;
        return bubble;
    }

    async function send(text) {
        if (pending || !text.trim()) return;
        pending = true;
        addMessage("user", text.trim(), false);
        const placeholder = addMessage("assistant", "…", false);
        placeholder.classList.add("chat-bubble--loading");
        try {
            const result = await fetchJson(`${API_BASE}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: text.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
            });
            placeholder.classList.remove("chat-bubble--loading");
            placeholder.textContent = "";
            renderMarkdown(placeholder, result.answer || "No answer.");
            (result.warnings || []).forEach((w) => placeholder.appendChild(el("p", "chat-warning", w)));
            window.pgAnalytics?.track?.("app_event", "fantasy_chat", { tools: (result.tools_used || []).join(",") });
        } catch (err) {
            placeholder.classList.remove("chat-bubble--loading");
            placeholder.textContent = `Sorry — ${err.message}`;
        } finally {
            pending = false;
        }
    }

    els.form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = els.input.value;
        els.input.value = "";
        send(text);
    });

    els.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            els.form.requestSubmit();
        }
    });

    if (els.starts) {
        els.starts.querySelectorAll(".chat-chip").forEach((chip) => {
            chip.addEventListener("click", () => send(chip.dataset.prompt));
        });
    }
})();
