// Passkey ceremonies for the login and account pages. The server speaks the
// WebAuthn JSON shape (base64url strings); the browser API wants
// ArrayBuffers. This file converts in both directions and nothing else, so
// the pages stay about their own UI.
(function () {
    function toBytes(value) {
        const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
        return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    }

    function toBase64url(buffer) {
        let binary = "";
        for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function descriptors(list) {
        return (list || []).map((item) => ({ ...item, id: toBytes(item.id) }));
    }

    function credentialToJSON(credential) {
        const response = credential.response;
        const json = {
            id: credential.id,
            rawId: toBase64url(credential.rawId),
            type: credential.type,
            clientExtensionResults: credential.getClientExtensionResults?.() || {},
            response: { clientDataJSON: toBase64url(response.clientDataJSON) },
        };
        if (credential.authenticatorAttachment) {
            json.authenticatorAttachment = credential.authenticatorAttachment;
        }
        if (response.attestationObject) {
            json.response.attestationObject = toBase64url(response.attestationObject);
            json.response.transports = response.getTransports?.() || [];
        }
        if (response.authenticatorData) {
            json.response.authenticatorData = toBase64url(response.authenticatorData);
            json.response.signature = toBase64url(response.signature);
            json.response.userHandle = response.userHandle ? toBase64url(response.userHandle) : null;
        }
        return json;
    }

    async function postJSON(url, body) {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            credentials: "same-origin",
            cache: "no-store",
            body: JSON.stringify(body || {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || "Something went wrong. Try again.");
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    // A dismissed or timed-out browser prompt is not an error worth a red
    // message; callers check for this and stay quiet.
    function isCancelled(error) {
        return error?.name === "NotAllowedError" || error?.name === "AbortError";
    }

    function supported() {
        return Boolean(window.PublicKeyCredential && navigator.credentials?.create);
    }

    async function conditionalSupported() {
        if (!supported()) return false;
        try {
            return Boolean(await PublicKeyCredential.isConditionalMediationAvailable?.());
        } catch {
            return false;
        }
    }

    async function register({ password, name }) {
        const { publicKey } = await postJSON("/login/passkey/register/options", { password });
        const credential = await navigator.credentials.create({
            publicKey: {
                ...publicKey,
                challenge: toBytes(publicKey.challenge),
                user: { ...publicKey.user, id: toBytes(publicKey.user.id) },
                excludeCredentials: descriptors(publicKey.excludeCredentials),
            },
        });
        return postJSON("/login/passkey/register", { credential: credentialToJSON(credential), name });
    }

    // `conditional` hangs the request on the username field's autofill menu
    // instead of opening a dialog; pass a `signal` so a button press can take
    // over from it.
    async function signIn({ next, conditional = false, signal } = {}) {
        const { publicKey } = await postJSON("/login/passkey/options");
        const credential = await navigator.credentials.get({
            publicKey: {
                ...publicKey,
                challenge: toBytes(publicKey.challenge),
                allowCredentials: descriptors(publicKey.allowCredentials),
            },
            mediation: conditional ? "conditional" : undefined,
            signal,
        });
        try {
            return await postJSON("/login/passkey", { credential: credentialToJSON(credential), next });
        } catch (error) {
            // The server no longer holds this passkey. Where the browser
            // supports it, ask it to drop the passkey so it stops offering it.
            if (error.data?.unknownCredential) {
                PublicKeyCredential.signalUnknownCredential?.({
                    rpId: publicKey.rpId,
                    credentialId: error.data.credentialId,
                })?.catch?.(() => {});
            }
            throw error;
        }
    }

    window.Passkeys = { supported, conditionalSupported, register, signIn, isCancelled };
})();
