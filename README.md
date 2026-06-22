# iNaturalist ID Tip Review

A keyboard-first, human-in-the-loop review queue for finding useful remarks attached to iNaturalist identifications.

The app queries the public V2 `exemplar_identifications` resource for **un-nominated identification remarks**, scores explanatory language locally, and presents promising candidates for review. When an Observation owner username is entered, it instead reads that user’s public observations and considers non-empty remarks from every current identification on those observations, regardless of who made the ID. It does not call nomination or voting endpoints. “Review on iNaturalist” opens the source observation so you can nominate the remark yourself; “Reject locally” only hides the candidate in your browser.

It requests 50 API records per page and continues through at most 1,000 records for each filter set. One ranked candidate is displayed at a time.

## Review controls

- `N` — open the source observation so you can nominate the remark on iNaturalist
- `R` — reject the candidate locally (hides it from your queue)
- `S` — skip to the next candidate
- `U` — undo the last local decision
- `?` — show keyboard shortcuts

## Building a queue

- **Family or genus** — type a higher-rank taxon name to resolve it (via the `inat-trees-worker` `search-taxa` endpoint), then optionally **expand to the top 50/100/200 most-observed species** under it. Expansion uses the iNaturalist `species_counts` endpoint and queries those species together.
- **Taxon ID** — a numeric iNaturalist taxon id to focus the queue directly. Leave blank for a global queue.
- **Country** — narrow the queue to observations within a country (or other place) resolved through iNaturalist place autocomplete.
- **Tip language** — limit the queue to remarks detected as a chosen language. Detection is heuristic and shown as a tag on each card.
- **Remark contains** / **Minimum words** — text and length filters.
- **Observation owner** — limit the queue to identification remarks attached to one iNaturalist user’s observations.

Filters are reflected in the URL so a queue can be bookmarked and shared.

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
- Makes all iNaturalist API requests directly from the reviewer’s browser, so reviewers use their own network/IP rate allocation.
- Resolves family/genus names through cloudflare worker `inat-trees-worker` `search-taxa` endpoint; no other backend is involved.
- Stores review/reject decisions only in local storage, to avoid re-showing candidates you have already triaged. Nothing is sent anywhere else.
- Does not request an iNaturalist login, API token, or OAuth grant.
- Does not nominate, vote, downvote, or post on a user’s behalf.

## Deployment

Pushes to `main` run unit tests and deploy the static files with the official GitHub Pages actions. Repository Pages must allow GitHub Actions deployment; the workflow requests first-run enablement.

This is an independent project and is not affiliated with or endorsed by iNaturalist.

## License

Released under the [MIT License](LICENSE).
