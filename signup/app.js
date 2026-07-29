(function () {
    const form = document.getElementById("signupForm");
    const status = document.getElementById("signupStatus");
    const inviteCode = document.getElementById("inviteCode");
    const username = document.getElementById("username");
    const password = document.getElementById("password");
    const confirmPassword = document.getElementById("confirmPassword");
    const button = form.querySelector("button[type='submit']");

    function safeNextPath() {
        const params = new URLSearchParams(window.location.search);
        const next = params.get("next") || "/";
        try {
            const url = new URL(next, window.location.origin);
            if (url.origin !== window.location.origin) {
                return "/";
            }
            if (url.pathname.startsWith("/login") || url.pathname.startsWith("/signup")) {
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
        button.querySelector("span").textContent = isBusy ? "Creating account" : "Create account";
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const codeValue = inviteCode.value.trim();
        const userValue = username.value.trim();
        const passwordValue = password.value;

        if (!codeValue || !userValue || !passwordValue) {
            setStatus("Fill in every field.");
            return;
        }

        // Checked here as a courtesy; the server never sees this field and
        // does its own validation of everything it does see.
        if (passwordValue !== confirmPassword.value) {
            setStatus("Those passwords don't match.");
            confirmPassword.select();
            return;
        }

        setBusy(true);
        setStatus("");

        try {
            const response = await fetch("/login/signup", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "same-origin",
                body: JSON.stringify({
                    username: userValue,
                    password: passwordValue,
                    inviteCode: codeValue,
                    next: safeNextPath(),
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                window.pgAnalytics?.track?.("signup_failed", { status: response.status });
                throw new Error(data.error || "Unable to create the account.");
            }

            window.pgAnalytics?.track?.("signup_success");
            setStatus("Account created. Opening page.", true);
            window.location.assign(data.redirect || safeNextPath());
        } catch (error) {
            setStatus(error.message || "Unable to create the account.");
        } finally {
            setBusy(false);
        }
    });

    inviteCode.focus();
})();
