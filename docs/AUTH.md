# Auth

Multi-user, email + password. Two-token scheme.

## Tokens
- **Access token** — short-lived JWT (HS256, default 15 min), signed with `SECRET_KEY`. Sent as `Authorization: Bearer`. Stateless; the server just verifies the signature + `exp`.
- **Refresh token** — opaque random string (48 bytes url-safe). The server stores **only its SHA-256 hash**, with an expiry (default 30 days). **Rotated on every use**: `/api/auth/refresh` revokes the presented token and issues a new pair, so a stolen-but-used token is detectable (the real client's next refresh fails).

## Passwords
`bcrypt`, pre-hashed with sha256 so passwords longer than bcrypt's 72-byte limit keep full entropy (`app/auth.py`). We use the `bcrypt` package directly — **not** passlib (unmaintained, and it breaks against bcrypt ≥ 4).

## Flows
```
signup(email,pw)  → create user → issue (access, refresh)
login(email,pw)   → verify → issue (access, refresh)
refresh(refresh)  → validate+revoke old → issue new pair
logout(refresh)   → revoke
me()              → current user (requires access)
```

## Where clients keep tokens
- **Web app**: keep the **access token in memory** and the **refresh token in `localStorage`** (or, more securely, have the API set the refresh token as an `HttpOnly; Secure; SameSite=Strict` cookie and add a `/api/auth/refresh` that reads it — a good hardening once the basics work). Since the web app is same-origin with the API, cookies are easy here.
- **Extension**: store both in `chrome.storage.local` (see `extension/lib/api.js`). Extension pages aren't reachable by web XSS, so this is acceptable; still, treat the refresh token as a secret.

`extension/lib/api.js` already implements **refresh-on-401**: any authed call that gets a 401 refreshes once and retries.

## Hardening backlog (not blocking v1)
- Rate-limit `login`/`signup` (per-IP + per-email) to blunt credential stuffing. Add `slowapi` or do it at the edge.
- Email verification + password reset (email sender).
- Lock `SECRET_KEY` rotation story (invalidates access tokens; refresh tokens survive).
- Consider moving the web refresh token to an HttpOnly cookie (above).
- Add `argon2` as an alternative hasher if you prefer.
