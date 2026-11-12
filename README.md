# AvatarExtraction

Public LinkedIn avatar dashboard with a compact dark interface and session history. No login required. Submit up to 300 URLs, continue adding requests while jobs run, and select pending, successful, or failed entries in the sidebar.

## Development

Requires Node 22.13+. Set `BRIGHTDATA_API_KEY` in ignored `.env` locally and the Sites secret environment in production. The key never reaches the browser. Run `npm run dev`.

Verification:

```sh
node tests/avatar-jobs.test.mjs
node --experimental-strip-types tests/avatar.test.mjs
npx tsc --noEmit
npm run build
```

The job tests use in-memory SQLite and mocked provider/image responses; they do not incur Bright Data charges.

## Request flow

`POST /api/jobs` accepts `{urls: string[], storeImages?: boolean, provider?: "brightdata" | "identity-resolver" | "apify"}`. Omitted provider defaults to Bright Data. The selector routes only to the chosen provider; cache keys, active jobs, and history retain that choice. Retry uses the failed entry’s original provider. Existing jobs migrate to Bright Data. Every normalized URL checks the shared D1 cache first (24-hour TTL, shortened by external image expiry). Cache hits return immediately without provider requests. Cache misses are persisted before returning HTTP 202. Duplicate active requests with the same storage preference reuse the same job.

Atomic database claims enforce a global maximum of three active jobs across Worker instances. Submission runs through `waitUntil`. Bright Data receives a per-job authenticated callback URL; its completion callback persists the result and starts the next queued work without requiring an open browser. `GET /api/jobs/:id` returns durable status and also runs recovery checks. The browser polls local job status every 2.5 seconds, with an 8-second reconnect delay after network errors. IDs are random read capabilities; there is no public job-list endpoint.

Background continuation depends on provider callbacks. If callbacks are not delivered, the next job API request resumes progress checks. There is no always-running scheduler: timeout expiry and recovery occur on callback or API activity. Active lookups expire after 20 minutes from submission to the provider; queue waiting time does not expire them. Global concurrency bounds locally tracked jobs; a provider job whose POST timed out or whose local deadline expired may still run upstream.

Only `name|url|avatar` is requested using Bright Data's documented `custom_output_fields`. This filters returned fields; it does not guarantee that Bright Data performs a faster internal scrape. See [Bright Data asynchronous requests](https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests).

## Image storage

The unchecked “Store photos — I have permission” option authorizes copying that request's photo to the Site's R2 bucket. With no permission, the external image URL is retained. Cached external photos can be copied without scraping again. Stored images are content-addressed and served by `/api/images/:hash`. Downloads allow only LinkedIn image hosts, disable redirects, enforce a 2 MB limit, and accept JPEG/PNG/WebP signatures. Failed storage falls back to the external URL. Cache expiry does not delete stored objects; no automatic object-retention policy is configured.

## Reliability and timings

Transient provider failures use bounded exponential retries. Submission retries only explicit 429/503 responses; an ambiguous POST timeout is not automatically resubmitted to avoid duplicate charges. GET operations have a six-second overall budget; submission has eight seconds; photo downloads have five seconds. Callback failures return a retryable response. Missing photos and account failures have distinct messages, with manual Retry in the UI.

D1 records queue wait, API submission, observed scraping interval, result retrieval, optional image storage, browser image loading, and total duration in milliseconds. Stage timings are returned by the job endpoint. Completion and first browser image-load events are also logged. Scraping time includes provider queueing and notification/polling delay, not just processing CPU. Skipped stages on cache hits remain null. Browser image timing is client-reported and approximate.

History is stored in sessionStorage for the current tab (all pending entries and up to 600 completed entries); pending jobs resume after refresh. Clear completed only removes this tab's completed history, not server records or stored images. The older `/api/avatar` endpoint remains for compatibility and regression tests; the dashboard uses `/api/jobs`.

## Deployment

Sites provisions D1 `DB` and R2 `BUCKET` from `.openai/hosting.json`. Drizzle migrations define the cache and job tables. Preserve existing applied migrations. Provider retrieval time can exceed one minute for uncached profiles; asynchronous processing improves responsiveness and caching eliminates repeated scrapes.

## Identity Resolver

The Identity Resolver option sends a server-side GET to `https://ai.mihajlo.mk/api/identity-resolver/v1/resolve` with `platform=linkedin`, the encoded profile `url`, and `Accept: application/json`. It requires no API key, and the Bright Data key is never sent to it. A result must have `ok: true`, `platform: "linkedin"`, a matching `profile_url`, and a supported `avatar` or `picture`. Only name, profile URL, and photo URL are retained. Resolver photos from its `/storage/identity-resolver/linkedin/` path are supported alongside LinkedIn image URLs.

The GET runs inside the same bounded background queue, with retries for transient errors and an eight-second total request budget. Unlike Bright Data, it returns the result directly and needs no callback. Its internal scrape duration is not exposed: submission timing includes server response wait, retrieval timing covers reading/parsing the response, and scraping timing stays null. Provider switching never silently falls back or uses the other provider’s cached result.

Batches accept up to 300 URLs. The browser validates the whole batch, submits groups of 20 with at most three requests in flight, and retains any unsubmitted URLs for retry. Provider concurrency remains three globally. `/api/jobs/status` reads up to 300 random job IDs in grouped queries, so polling does not issue a separate HTTP request for every queued profile. History retains all pending jobs and up to 600 completed entries.

## Apify

Select **Apify** to run `true-data~linkedin-profile-scraper`. Set `APIFY_API_KEY` in the ignored local `.env` and as a secret in Sites runtime. The token is sent only to `api.apify.com` using the Authorization header.

The integration uses the same actor and `profileUrls` input as the synchronous example, but starts asynchronous `/v2/acts/true-data~linkedin-profile-scraper/runs` jobs to avoid blocking HTTP requests. Each uncached profile starts one run, with at most three active lookups globally; actor per-run charges therefore apply separately. Authenticated completion webhooks and polling retrieve the finished dataset. Dataset downloads select only name, input/profile URL, avatar, default-avatar and error fields. Other actor output remains on Apify and is not retained by the dashboard. Scraping timing includes actor startup and notification delay.

Apify cache keys include provider, actor and API-key scope. History and Retry preserve Apify selection after refresh. Missing photos, mismatched profiles, invalid credentials, depleted credits, failed/aborted/timed-out runs, and malformed responses have clear errors. POST timeouts are not automatically retried because a run may already have been created. The 300-profile input limit and optional permitted image storage also apply to Apify.

References: [actor](https://apify.com/true-data/linkedin-profile-scraper), [asynchronous runs](https://docs.apify.com/api/v2/actors-runs-post), [webhooks](https://docs.apify.com/integrations/webhooks/ad-hoc-webhooks).
