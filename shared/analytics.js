(function () {
    'use strict';

    const ENDPOINT = '/api/analytics/events';
    const VISITOR_KEY = 'pg_visitor_id';
    const SESSION_KEY = 'pg_session_id';
    const SESSION_STARTED_KEY = 'pg_session_started_at';
    const SESSION_TTL_MS = 30 * 60 * 1000;

    function randomId(prefix) {
        if (window.crypto && crypto.randomUUID) {
            return `${prefix}_${crypto.randomUUID()}`;
        }
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    }

    function getStoredId(key, prefix, storage) {
        try {
            let value = storage.getItem(key);
            if (!value) {
                value = randomId(prefix);
                storage.setItem(key, value);
            }
            return value;
        } catch (_) {
            return randomId(prefix);
        }
    }

    function getSessionId() {
        try {
            const started = Number(sessionStorage.getItem(SESSION_STARTED_KEY) || 0);
            const now = Date.now();
            let sessionId = sessionStorage.getItem(SESSION_KEY);
            if (!sessionId || !started || now - started > SESSION_TTL_MS) {
                sessionId = randomId('sess');
                sessionStorage.setItem(SESSION_KEY, sessionId);
                sessionStorage.setItem(SESSION_STARTED_KEY, String(now));
            }
            return sessionId;
        } catch (_) {
            return randomId('sess');
        }
    }

    function setCookie(name, value, maxAgeSeconds) {
        document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
    }

    function appFromPath(path) {
        if (!path || path === '/') return 'home';
        return path.replace(/^\/+/, '').split('/')[0] || 'home';
    }

    const visitorId = getStoredId(VISITOR_KEY, 'vis', localStorage);
    const sessionId = getSessionId();
    setCookie('pg_visitor_id', visitorId, 365 * 24 * 60 * 60);
    setCookie('pg_session_id', sessionId, 30 * 60);

    function send(payload) {
        const body = JSON.stringify({
            app: appFromPath(location.pathname),
            path: location.pathname,
            referrer: document.referrer || null,
            visitor_id: visitorId,
            session_id: sessionId,
            ...payload,
        });

        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/json' });
            if (navigator.sendBeacon(ENDPOINT, blob)) return;
        }

        fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            keepalive: true,
            body,
        }).catch(() => {});
    }

    function track(eventName, metadata) {
        send({
            event_type: 'app_event',
            event_name: eventName,
            metadata: metadata || null,
        });
    }

    window.pgAnalytics = {
        visitorId,
        sessionId,
        track,
        pageView(metadata) {
            send({
                event_type: 'page_view',
                event_name: 'page_view',
                metadata: metadata || null,
            });
        },
    };

    window.addEventListener('load', () => {
        window.pgAnalytics.pageView({
            title: document.title,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            screen: `${screen.width}x${screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
    });
})();
