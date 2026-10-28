# Instagram setup (Instagram API with Instagram Login)

The Instagram adapter uses Meta's "Instagram API with Instagram Login". Creators sign in
with their Instagram professional account directly at `instagram.com` — no Facebook Page
link is required. Publishing uses `graph.instagram.com`.

## Why not Facebook Login?

The original integration sent users to `facebook.com/dialog/oauth` with a plain `scope`
parameter. The Meta app is a Business-type app, and Business apps must use Facebook Login
for Business with a `config_id`; the plain-`scope` dialog fails after login with a
"Feature unavailable" page, so no OAuth callback ever completed (13 started flows, 0
connections). Facebook Login also requires the creator's Instagram account to be linked
to a Facebook Page, only issues short-lived (~1 hour) user tokens without a refresh
token, and its `ig_refresh_token` grant does not exist on `graph.facebook.com`. Instagram
Login removes the Page requirement and issues 60-day tokens that refresh with the
`ig_refresh_token` grant on `graph.instagram.com`.

## Meta dashboard configuration (one-time)

In [developers.facebook.com](https://developers.facebook.com) for the Crossposter app:

1. **Add the Instagram product**: App Dashboard → Add product → **Instagram** → "API
   setup with Instagram business login".
2. **Copy the Instagram credentials**: Instagram → API setup with Instagram business
   login → the **Instagram App ID** and **Instagram App Secret**. These are *different*
   values from the Facebook App ID/secret — the worker must use the Instagram pair.
3. **Whitelist the redirect URI**: in Business login settings, add
   `https://crossposter.divine.video/connections/instagram/callback` to Valid OAuth
   Redirect URIs.
4. **While the app is in Development mode**, only accounts with a role can connect: App
   roles → Instagram Testers → invite the Instagram account, then accept the invite in
   the Instagram app (Settings → Website permissions → Apps and websites → Tester
   invites).
5. **Before public launch**, complete App Review for Advanced Access on
   `instagram_business_basic` and `instagram_business_content_publish`.

Creator-side requirement: the Instagram account must be a professional account
(Business or Creator). Personal accounts cannot use the content publishing API.

## Worker configuration (retired here)

This document describes the historical adapter. Do not update production secrets or deploy from this checkout. Use [Divine Connections](https://github.com/divinevideo/divine-connections) for the current provider setup and release procedure. See the [deployment transition](../README.md#deployment-transition) for the pending production cutover and retirement gates. For local tests only, use test credentials in a gitignored `.dev.vars` file.

## Token lifecycle

- OAuth code → short-lived token (`api.instagram.com/oauth/access_token`) → immediately
  exchanged for a long-lived token (`grant_type=ig_exchange_token`, ~60 days).
- The long-lived token is stored as both access and refresh token; the publisher
  refreshes it near expiry with `grant_type=ig_refresh_token`. Meta requires the token
  to be at least 24 hours old before refresh, which the near-expiry refresh satisfies.
