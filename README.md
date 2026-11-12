# AvatarExtraction dashboard

Enter an individual LinkedIn profile URL and select **Extract avatar**. The server requests the public profile page and extracts a LinkedIn-hosted profile photo, when accessible. Results include a preview, copy-image-URL button, original image link, and in-memory recent history.

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

## Limits

LinkedIn frequently blocks automated public-page requests or requires sign-in, even for otherwise public profiles. This app reports those failures; it cannot guarantee arbitrary profile extraction. It does not use an authenticated LinkedIn session or a paid enrichment provider. Reliable broader coverage would require a suitable authorized provider integration.

Requests are restricted to HTTPS personal LinkedIn profile URLs. Redirects are not followed. Responses have a 15-second timeout and 2 MB body limit. Only recognizable LinkedIn CDN profile-photo URLs are accepted, preventing generic social-sharing logos from being presented as avatars. Recent results are kept only in browser memory and cleared on refresh. Image links may expire.

Source: `app/page.tsx` (dashboard), `app/globals.css` (responsive styles), `app/api/avatar/route.ts` (endpoint), `lib/avatar.ts` (validation and extraction).
