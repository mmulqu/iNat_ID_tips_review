# iNaturalist ID Tip Review

A keyboard-first, human-in-the-loop review queue for finding useful remarks attached to iNaturalist identifications.

The app queries the public V2 `exemplar_identifications` resource for **un-nominated identification remarks**, scores explanatory language locally, and presents promising candidates for review. When an Observation owner username is entered, it instead reads that user’s public observations and considers non-empty remarks from every current identification on those observations, regardless of who made the ID. It does not call nomination or voting endpoints. “Review on iNaturalist” opens the source observation; “Reject locally” only records a review decision.

It requests 50 API records per page and continues through at most 1,000 records for each filter set. One ranked candidate is displayed at a time.

## Review controls

- `N` — open the source observation and mark the candidate as sent to review
- `R` — reject the candidate locally
- `S` — record a skip and move to the next candidate
- `U` — undo the last local decision
- `?` — show keyboard shortcuts

Use a numeric iNaturalist Taxon ID to focus the queue on a clade. Leave it blank for a global queue. Search and minimum-word filters are reflected in the URL so a queue can be bookmarked.

Use Observation owner to limit the queue to identification remarks attached to one iNaturalist user’s observations. Taxon, text, and word-count filters continue to apply in this mode.

## Run locally

The site has no build step or runtime dependencies.

```sh
npm test
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Data and privacy boundaries

- Reads public data from `https://api.inaturalist.org/v2/exemplar_identifications`.
- Reads `https://api.inaturalist.org/v1/observations` when an observation owner is supplied.
- Retrieves the active candidate’s label from the public V2 taxa endpoint and caches it locally.
- Makes all iNaturalist API requests directly from the reviewer’s browser. The Worker is not an iNaturalist API proxy, so reviewers use their own network/IP rate allocation.
- Stores review/reject decisions only in local storage.
- Keeps a capped 1,000-row N/R/S audit log locally and supports CSV download.
- Sends pending rows in batches to a protected Cloudflare Worker when a submission key is entered.
- Does not request an iNaturalist login, API token, or OAuth grant.
- Does not nominate, vote, downvote, or post on a user’s behalf.

## Deployment

Pushes to `main` run unit tests and deploy the static files with the official GitHub Pages actions. Repository Pages must allow GitHub Actions deployment; the workflow requests first-run enablement.

This is an independent project and is not affiliated with or endorsed by iNaturalist.

## Repository CSV Worker

The Worker in `worker/` validates review rows and appends them to `data/reviews.csv` through the GitHub Contents API. It deduplicates by event ID, retries write conflicts, and keeps the newest 1,000 rows. Browser code never receives the GitHub token.

Install dependencies and configure the two required secrets:

```sh
npm install
npx wrangler secret put GITHUB_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put SUBMISSION_KEY --config worker/wrangler.jsonc
npm run worker:deploy
```

`GITHUB_TOKEN` should be a fine-grained token restricted to this repository with **Contents: Read and write** permission. `SUBMISSION_KEY` is a separate shared key entered in the site’s Repository sync dialog. It authorizes submissions but grants no direct GitHub access.
