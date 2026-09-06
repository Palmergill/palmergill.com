(function () {
    const form = document.getElementById("loginForm");
    const status = document.getElementById("loginStatus");
    const username = document.getElementById("username");
    const password = document.getElementById("password");
    const button = form.querySelector("button[type='submit']");

    function safeNextPath() {
        const params = new URLSearchParams(window.location.search);
        const next = params.get("next") || "/";
        try {
            const url = new URL(next, window.location.origin);
            if (url.origin !== window.location.origin) {
                return "/";
            }
            if (url.pathname === "/login" || url.pathname === "/login/") {
                return "/";
            }
            return `${url.pathname}${url.search}${url.hash}`;
        } catch {
            return "/";
        }
    }

    function setStatus(message, isSuccess) {
        status.textContent = message;
        status.classList.toggle("is-success", Boolean(isSuccess));
    }

    function setBusy(isBusy) {
        button.disabled = isBusy;
        button.querySelector("span").textContent = isBusy ? "Signing in" : "Sign in";
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const userValue = username.value.trim();
        const passwordValue = password.value;
        if (!userValue || !passwordValue) {
            setStatus("Enter both username and password.");
            return;
        }

        setBusy(true);
        setStatus("");

        try {
            const response = await fetch("/login/session", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "same-origin",
                body: JSON.stringify({
                    username: userValue,
                    password: passwordValue,
                    next: safeNextPath(),
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                window.pgAnalytics?.track?.("login_failed", { status: response.status });
                throw new Error(data.error || "Unable to sign in.");
            }

            window.pgAnalytics?.track?.("login_success", { role: data.role });
            setStatus("Signed in. Opening page.", true);
            window.location.assign(data.redirect || safeNextPath());
        } catch (error) {
            setStatus(error.message || "Unable to sign in.");
            password.select();
        } finally {
            setBusy(false);
        }
    });

    // Discover signup availability from the API so this remains compatible
    // with deployments that have not picked up the open-signup backend yet.
    async function revealSignupPrompt() {
        const prompt = document.getElementById("signupPrompt");
        if (!prompt) return;

        try {
            const response = await fetch("/login/signup", {
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Accept": "application/json" },
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data.enabled) prompt.hidden = false;
        } catch {
            // Signup discovery is progressive enhancement — a failed check
            // just leaves the prompt hidden.
        }
    }

    username.focus();
    revealSignupPrompt();
})();
