# AvatarExtraction dashboard

Enter an individual LinkedIn profile URL and select **Extract avatar**. The server uses Bright Data’s LinkedIn Profiles API to retrieve a public profile photo. It starts one asynchronous job and polls that job until the result is ready. Results include a preview, copy-image-URL button, original image link, and in-memory recent history.

## Run locally

Requires Node.js 22.13 or newer.

```sh
npm run install:ci
npm run dev
```

## Verify and build

```sh
node --experimental-strip-types tests/avatar.test.mjs
npx tsc --noEmit
npm run build
```

## Provider configuration

Set `BRIGHTDATA_API_KEY` in the ignored local `.env` for development and as a secret in Sites runtime environment variables for production. The hosted key is read from the server runtime environment; `.env` is never deployed. Activate the Bright Data account and enable access to its LinkedIn Profiles scraper (`gd_l1viktl72bvl7bjuj0`).

The browser calls `/api/avatar` with `{url}` once, then polls with the returned signed `{job}` token. Tokens expire in 30 minutes and bind each snapshot to the requested profile; the browser never receives the API key. The frontend waits up to ten minutes. Public visitors need no sign-in. Lookups use the owner's Bright Data account and may consume provider credits.

## Limits

Provider coverage and public photo availability vary. Default placeholder avatars are rejected. Inactive accounts, invalid keys, depleted credits, rate limits, failed jobs, and missing photos return distinct errors. Only avatar, name, and profile URL are sent to the browser; other provider profile fields are discarded. Recent results remain in browser memory and clear on refresh.

`lib/avatar.ts` retains the legacy direct-page extraction helper for regression tests; the production API uses Bright Data exclusively.

Source: `app/page.tsx` (dashboard), `app/globals.css` (responsive styles), `app/api/avatar/route.ts` (endpoint), `lib/avatar.ts` (validation, provider requests, and signed jobs).
