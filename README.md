# AvatarExtraction

Public LinkedIn avatar dashboard with a compact dark interface and session history. No login required. Submit up to 20 URLs, continue adding requests while jobs run, and select pending, successful, or failed entries in the sidebar.

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

`POST /api/jobs` accepts `{urls: string[], storeImages?: boolean}`. Every normalized URL checks the shared D1 cache first (24-hour TTL, shortened by external image expiry). Cache hits return immediately without provider requests. Cache misses are persisted before returning HTTP 202. Duplicate active requests with the same storage preference reuse the same job.

Atomic database claims enforce a global maximum of three active jobs across Worker instances. Submission runs through `waitUntil`. Bright Data receives a per-job authenticated callback URL; its completion callback persists the result and starts the next queued work without requiring an open browser. `GET /api/jobs/:id` returns durable status and also runs recovery checks. The browser polls local job status every 2.5 seconds, with an 8-second reconnect delay after network errors. IDs are random read capabilities; there is no public job-list endpoint.

Background continuation depends on provider callbacks. If callbacks are not delivered, the next job API request resumes progress checks. There is no always-running scheduler: timeout expiry and recovery occur on callback or API activity. Requests expire after 20 minutes. Global concurrency bounds locally tracked jobs; a provider job whose POST timed out or whose local deadline expired may still run upstream.

Only `name|url|avatar` is requested using Bright Data's documented `custom_output_fields`. This filters returned fields; it does not guarantee that Bright Data performs a faster internal scrape. See [Bright Data asynchronous requests](https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests).

## Image storage

The unchecked “Store photos — I have permission” option authorizes copying that request's photo to the Site's R2 bucket. With no permission, the external image URL is retained. Cached external photos can be copied without scraping again. Stored images are content-addressed and served by `/api/images/:hash`. Downloads allow only LinkedIn image hosts, disable redirects, enforce a 2 MB limit, and accept JPEG/PNG/WebP signatures. Failed storage falls back to the external URL. Cache expiry does not delete stored objects; no automatic object-retention policy is configured.

## Reliability and timings

Transient provider failures use bounded exponential retries. Submission retries only explicit 429/503 responses; an ambiguous POST timeout is not automatically resubmitted to avoid duplicate charges. GET operations have a six-second overall budget; submission has eight seconds; photo downloads have five seconds. Callback failures return a retryable response. Missing photos and account failures have distinct messages, with manual Retry in the UI.

D1 records queue wait, API submission, observed scraping interval, result retrieval, optional image storage, browser image loading, and total duration in milliseconds. Stage timings are returned by the job endpoint. Completion and first browser image-load events are also logged. Scraping time includes provider queueing and notification/polling delay, not just processing CPU. Skipped stages on cache hits remain null. Browser image timing is client-reported and approximate.

History is stored in sessionStorage for the current tab (up to 50 entries); pending jobs resume after refresh. Clear completed only removes this tab's completed history, not server records or stored images. The older `/api/avatar` endpoint remains for compatibility and regression tests; the dashboard uses `/api/jobs`.

## Deployment

Sites provisions D1 `DB` and R2 `BUCKET` from `.openai/hosting.json`. Drizzle migrations define the cache and job tables. Preserve existing applied migrations. Provider retrieval time can exceed one minute for uncached profiles; asynchronous processing improves responsiveness and caching eliminates repeated scrapes.
