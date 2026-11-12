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

Provider coverage and public photo availability vary. Default placeholder avatars are rejected. Inactive accounts, invalid keys, depleted credits, rate limits, failed jobs, and missing photos return distinct errors. Only avatar, name, and profile URL are sent to the browser; other provider profile fields are discarded. History is retained in sessionStorage for the current browser tab, including refreshes, with a 24-hour freshness limit. Clear removes that tab’s history.

`lib/avatar.ts` retains the legacy direct-page extraction helper for regression tests; the production API uses Bright Data exclusively.

Source: `app/page.tsx` (dashboard), `app/globals.css` (responsive styles), `app/api/avatar/route.ts` (endpoint), `lib/avatar.ts` (validation, provider requests, and signed jobs).

## Lookup performance

Bright Data is the bottleneck for unseen profiles: polling requests are fast, but the collection job can exceed a minute. A synchronous endpoint benchmark also exceeded its 60-second limit, so production keeps the resumable asynchronous workflow.

Successful photo results are cached for up to 24 hours, shortened by the image URL expiry. Cloudflare D1 provides a shared persistent cache across regions and deployments; edge and bounded memory caches remain the first tier. No full provider profile records are stored. Expired database rows are removed on writes. The browser can reuse a valid result from its tab's session history without a server request. Broken images invalidate the corresponding browser entry.

In-progress jobs are reused by the edge cache for ten minutes. Concurrent requests in the same worker share work. Pending-job reuse is regional, not globally atomic. First-time lookups still depend on Bright Data. Browser polling remains every second for the first minute and every three seconds thereafter.
