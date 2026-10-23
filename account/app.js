(function () {
    const passkeys = window.Passkeys;
    const loading = document.getElementById("accountLoading");
    const signedOut = document.getElementById("accountSignedOut");
    const panel = document.getElementById("accountPanel");
    const list = document.getElementById("passkeyList");
    const empty = document.getElementById("passkeyEmpty");
    const form = document.getElementById("passkeyForm");
    const nameInput = document.getElementById("passkeyName");
    const passwordInput = document.getElementById("passkeyPassword");
    const status = document.getElementById("passkeyStatus");
    const button = form.querySelector("button[type='submit']");

    function setStatus(message, isSuccess) {
        status.textContent = message;
        status.classList.toggle("is-success", Boolean(isSuccess));
    }

    function formatDate(value) {
        if (!value) return null;
        return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }

    // A starting name for the passkey, from the device this is happening on.
    function suggestedName() {
        const ua = navigator.userAgent;
        if (/iPhone/.test(ua)) return "iPhone";
        if (/iPad/.test(ua)) return "iPad";
        if (/Android/.test(ua)) return "Android";
        if (/Macintosh/.test(ua)) return "Mac";
        if (/Windows/.test(ua)) return "Windows";
        return "Passkey";
    }

    function render(items) {
        list.replaceChildren(...items.map((item) => {
            const row = document.createElement("li");
            row.className = "passkey-item";

            const text = document.createElement("div");
            const name = document.createElement("div");
            name.className = "passkey-item__name";
            name.textContent = item.name;
            const meta = document.createElement("div");
            meta.className = "passkey-item__meta";
            const used = formatDate(item.lastUsedAt);
            meta.textContent = `Added ${formatDate(item.createdAt)}${used ? ` · last used ${used}` : " · not used yet"}`;
            text.append(name, meta);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "login-button login-button--danger";
            remove.textContent = "Remove";
            remove.setAttribute("aria-label", `Remove passkey ${item.name}`);
            remove.addEventListener("click", () => removePasskey(item, remove));

            row.append(text, remove);
            return row;
        }));
        list.hidden = items.length === 0;
        empty.hidden = items.length > 0;
    }

    async function removePasskey(item, control) {
        if (!window.confirm(`Remove "${item.name}"? You won't be able to sign in with it anymore.`)) return;
        control.disabled = true;
        try {
            const response = await fetch(`/login/passkey/credentials/${item.id}`, {
                method: "DELETE",
                credentials: "same-origin",
                headers: { "Accept": "application/json" },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Couldn't remove that passkey.");
            render(data.passkeys);
            setStatus("Passkey removed.", true);
        } catch (error) {
            setStatus(error.message);
            control.disabled = false;
        }
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!passwordInput.value) {
            setStatus("Enter your current password.");
            return;
        }

        button.disabled = true;
        setStatus("Follow your browser's prompt to create the passkey.");
        try {
            const data = await passkeys.register({
                password: passwordInput.value,
                name: nameInput.value.trim() || suggestedName(),
            });
            render(data.passkeys);
            passwordInput.value = "";
            setStatus("Passkey added. You can use it next time you sign in.", true);
            window.pgAnalytics?.track?.("passkey_added");
        } catch (error) {
            setStatus(passkeys.isCancelled(error) ? "Passkey setup was cancelled." : error.message);
        } finally {
            button.disabled = false;
        }
    });

    // The nav publishes window.SiteSession on DOMContentLoaded, which is after
    // this script runs, so wait for it.
    const siteSession = () => new Promise((resolve) => {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => resolve(window.SiteSession), { once: true });
        } else {
            resolve(window.SiteSession);
        }
    });

    async function load() {
        try {
            const session = await siteSession();
            if (!session?.authenticated) {
                loading.hidden = true;
                signedOut.hidden = false;
                return;
            }

            const response = await fetch("/login/passkey/credentials", {
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Couldn't load your passkeys.");

            loading.hidden = true;
            document.getElementById("accountName").textContent = session.username;
            panel.hidden = false;
            render(data.passkeys);

            if (passkeys?.supported()) {
                form.hidden = false;
                nameInput.placeholder = suggestedName();
            } else {
                document.getElementById("passkeyUnsupported").hidden = false;
            }
        } catch (error) {
            loading.hidden = false;
            loading.textContent = error.message || "Couldn't load your account.";
        }
    }

    load();
})();
