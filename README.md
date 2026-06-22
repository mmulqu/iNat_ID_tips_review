# iNaturalist ID Tip Review

A keyboard-first, human-in-the-loop review queue for finding useful remarks attached to iNaturalist identifications.

The app queries the public V2 `exemplar_identifications` resource for **un-nominated identification remarks**, scores explanatory language locally, and presents promising candidates for review. It does not call nomination or voting endpoints. “Review on iNaturalist” opens the source observation; “Reject locally” only records a decision in the browser’s local storage.

## Review controls

- `N` — open the source observation and mark the candidate as sent to review
- `R` — reject the candidate locally
- `S` — skip to the next candidate
- `U` — undo the last local decision
- `?` — show keyboard shortcuts

Use a numeric iNaturalist Taxon ID to focus the queue on a clade. Leave it blank for a global queue. Search and minimum-word filters are reflected in the URL so a queue can be bookmarked.

## Run locally

The site has no build step or runtime dependencies.

```sh
npm test
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Data and privacy boundaries

- Reads public data from `https://api.inaturalist.org/v2/exemplar_identifications`.
- Retrieves the active candidate’s label from the public V2 taxa endpoint and caches it locally.
- Stores review/reject decisions only in local storage.
- Does not request an iNaturalist login, API token, or OAuth grant.
- Does not nominate, vote, downvote, or post on a user’s behalf.

## Deployment

Pushes to `main` run unit tests and deploy the static files with the official GitHub Pages actions. Repository Pages must allow GitHub Actions deployment; the workflow requests first-run enablement.

This is an independent project and is not affiliated with or endorsed by iNaturalist.
