import {
  normalizeCandidate,
  normalizeObservationCandidates,
  normalizeIdentificationCandidates,
  rankCandidates,
} from "./ranking.js";
import { detectLanguage, matchesLanguageFilter, LANGUAGE_LABELS } from "./language.js";

const API_URL = "https://api.inaturalist.org/v2/exemplar_identifications";
const OBSERVATIONS_URL = "https://api.inaturalist.org/v1/observations";
// No V2 identifications endpoint exists (/v2/identifications 404s), so this
// one feature uses V1. It still honours taxon_id and place_id filters.
const IDENTIFICATIONS_URL = "https://api.inaturalist.org/v1/identifications";
const TAXA_URL = "https://api.inaturalist.org/v2/taxa";
const SPECIES_COUNTS_URL = "https://api.inaturalist.org/v1/observations/species_counts";
const PLACES_AUTOCOMPLETE_URL = "https://api.inaturalist.org/v1/places/autocomplete";
const TREES_WORKER_URL = "https://inat-trees-worker.intrinsic3141.workers.dev/search-taxa";
const STORAGE_KEY = "inat-id-tip-review-decisions-v1";
const PAGE_SIZE = 200;
// iNaturalist limits deep pagination to 10,000 results (page * per_page) and
// ~10k requests/day; we defer to those rather than imposing a tighter cap.
const MAX_API_RECORDS = 10000;
const CANDIDATE_FIELDS = [
  "id",
  "identification.id",
  "identification.body",
  "identification.created_at",
  "identification.taxon.id",
  "identification.user.id",
  "identification.user.login",
  "identification.user.name",
  "identification.user.icon",
  "identification.user.identifications_count",
  "identification.observation.id",
  "identification.observation.photos.id",
  "identification.observation.photos.url",
  "identification.observation.photos.attribution",
  "cached_votes_total",
  "nominated_at",
].join(",");

const elements = {
  shell: document.querySelector(".review-shell"),
  card: document.querySelector("#review-card"),
  empty: document.querySelector("#empty-state"),
  error: document.querySelector("#error-state"),
  errorMessage: document.querySelector("#error-message"),
  form: document.querySelector("#filter-form"),
  observationOwner: document.querySelector("#observation-owner"),
  identifier: document.querySelector("#identifier-login"),
  taxonSearch: document.querySelector("#taxon-search"),
  taxonSuggestions: document.querySelector("#taxon-suggestions"),
  taxonId: document.querySelector("#taxon-id"),
  taxonExpand: document.querySelector("#taxon-expand"),
  countrySearch: document.querySelector("#country-search"),
  countrySuggestions: document.querySelector("#country-suggestions"),
  tipLanguage: document.querySelector("#tip-language"),
  query: document.querySelector("#query"),
  minimumWords: document.querySelector("#minimum-words"),
  queueLabel: document.querySelector("#queue-label"),
  image: document.querySelector("#candidate-image"),
  imagePlaceholder: document.querySelector("#image-placeholder"),
  imageCredit: document.querySelector("#image-credit"),
  commonName: document.querySelector("#common-name"),
  scientificName: document.querySelector("#scientific-name"),
  score: document.querySelector("#candidate-score"),
  tags: document.querySelector("#candidate-tags"),
  remark: document.querySelector("#candidate-remark"),
  identifier: document.querySelector("#identifier-details"),
  reject: document.querySelector("#reject-candidate"),
  skip: document.querySelector("#skip-candidate"),
  review: document.querySelector("#review-candidate"),
  undo: document.querySelector("#undo-decision"),
  retry: document.querySelector("#retry-load"),
  reset: document.querySelector("#reset-history"),
  shortcuts: document.querySelector("#shortcuts-dialog"),
  openShortcuts: document.querySelector("#open-shortcuts"),
  closeShortcuts: document.querySelector("#close-shortcuts"),
  toast: document.querySelector("#toast"),
};

const state = {
  queue: [],
  cursor: 0,
  decisions: readDecisions(),
  history: [],
  loading: false,
  request: null,
  page: 1,
  loadedCount: 0,
  hasMore: true,
  taxonCache: new Map(),
  filters: {
    ownerLogin: "",
    identifierLogin: "",
    taxonId: "",
    baseTaxonId: "",
    expand: 0,
    placeId: "",
    placeName: "",
    language: "any",
    query: "",
    minimumWords: 12,
  },
};

function readDecisions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeDecisions() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.decisions));
}

function updateStats() {
  elements.undo.disabled = state.history.length === 0;
}

function setLoading(loading) {
  state.loading = loading;
  elements.shell.setAttribute("aria-busy", String(loading));
  elements.card.classList.toggle("is-loading", loading);
  [elements.reject, elements.skip, elements.review].forEach((button) => {
    button.disabled = loading;
  });
  updateStats();
}

function activeCandidate() {
  return state.queue[state.cursor];
}

// Three queue sources: the default exemplar feed, observations by an owner, or
// identifications authored by a user. Identifier search takes precedence when
// both username fields are filled (combining the two is a rare case).
function identifierSearchActive() {
  return Boolean(state.filters.identifierLogin);
}

function ownerSearchActive() {
  return Boolean(state.filters.ownerLogin) && !identifierSearchActive();
}

function exemplarFeedActive() {
  return !ownerSearchActive() && !identifierSearchActive();
}

function setView(view) {
  elements.card.hidden = view !== "card";
  elements.empty.hidden = view !== "empty";
  elements.error.hidden = view !== "error";
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const expiry = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timeout));
}

function makeImageUrl(candidate) {
  const observationPhoto = candidate.photos.find((photo) => photo.url)?.url;
  const taxonPhoto = candidate.taxon.default_photo?.medium_url;
  const url = observationPhoto ?? taxonPhoto;
  return url?.replace("/square.", "/medium.") ?? "";
}

function updateTaxonPresentation(candidate) {
  if (candidate !== activeCandidate()) return;
  elements.commonName.textContent =
    candidate.taxon.preferred_common_name || candidate.taxon.name || `Taxon ${candidate.taxonId}`;
  elements.scientificName.textContent = candidate.taxon.name ?? "";

  if (elements.image.hidden && candidate.taxon.default_photo?.medium_url) {
    elements.image.src = candidate.taxon.default_photo.medium_url;
    elements.image.alt = `Reference photo for ${elements.commonName.textContent}`;
    elements.image.hidden = false;
    elements.imagePlaceholder.hidden = true;
    elements.imageCredit.textContent =
      candidate.taxon.default_photo.attribution ?? "Taxon photo via iNaturalist";
  }
}

async function hydrateCandidateTaxon(candidate) {
  if (!candidate.taxonId || candidate.taxon.name) return;

  if (!state.taxonCache.has(candidate.taxonId)) {
    const fields = "id,name,preferred_common_name,default_photo.medium_url,default_photo.attribution";
    const request = withTimeout(
      fetch(`${TAXA_URL}/${candidate.taxonId}?fields=${fields}`).then(async (response) => {
        if (!response.ok) throw new Error(`Taxon lookup returned ${response.status}`);
        const payload = await response.json();
        return payload.results?.[0] ?? {};
      }),
      8000,
      "Taxon lookup timed out",
    ).catch(() => ({}));
    state.taxonCache.set(candidate.taxonId, request);
  }

  candidate.taxon = await state.taxonCache.get(candidate.taxonId);
  updateTaxonPresentation(candidate);
}

function renderTags(candidate) {
  elements.tags.replaceChildren();
  const tags = candidate.tags.length ? candidate.tags : ["explanatory remark"];
  tags.forEach((label) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = label;
    elements.tags.append(tag);
  });
  if (candidate.language) {
    const langTag = document.createElement("span");
    langTag.className = "tag tag-language";
    langTag.textContent = LANGUAGE_LABELS[candidate.language] ?? candidate.language;
    langTag.title = "Detected tip language (heuristic)";
    elements.tags.append(langTag);
  }
}

function renderIdentifier(candidate) {
  const identifier = candidate.identifier;
  elements.identifier.replaceChildren();

  if (identifier.icon) {
    const avatar = document.createElement("img");
    avatar.src = identifier.icon;
    avatar.alt = "";
    avatar.loading = "lazy";
    elements.identifier.append(avatar);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "avatar-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    elements.identifier.append(placeholder);
  }

  const text = document.createElement("div");
  const label = document.createElement("span");
  const name = document.createElement("strong");
  const count = Number(identifier.identifications_count ?? 0).toLocaleString();
  label.textContent = `Identification by · ${count} IDs`;
  name.textContent = identifier.name || identifier.login || `User ${identifier.id ?? "unknown"}`;
  text.append(label, name);
  elements.identifier.append(text);
}

function renderCandidate() {
  const candidate = activeCandidate();
  setLoading(false);

  if (!candidate) {
    if (state.hasMore && state.loadedCount < MAX_API_RECORDS) {
      [elements.reject, elements.skip, elements.review].forEach((button) => {
        button.disabled = true;
      });
      elements.queueLabel.textContent = `${state.loadedCount} API records scanned · continuing in 1 second`;
      setTimeout(() => {
        if (!state.loading && !activeCandidate()) loadNextPage();
      }, 1000);
      return;
    }
    setView("empty");
    elements.queueLabel.textContent = "Queue complete";
    updateStats();
    return;
  }

  setView("card");
  const queuePosition = state.cursor + 1;
  const sourceLabel = identifierSearchActive()
    ? `identifications by @${state.filters.identifierLogin}`
    : ownerSearchActive()
      ? `observations by @${state.filters.ownerLogin}`
      : "un-nominated exemplar remarks";
  elements.queueLabel.textContent = `Candidate ${queuePosition} of ${state.queue.length} · ${state.loadedCount} ${sourceLabel} scanned`;
  updateTaxonPresentation(candidate);
  elements.score.textContent = candidate.score;
  elements.remark.textContent = candidate.remark;
  elements.review.dataset.url = candidate.observationUrl;
  renderTags(candidate);
  renderIdentifier(candidate);

  const imageUrl = makeImageUrl(candidate);
  if (imageUrl) {
    const commonName = candidate.taxon.preferred_common_name || candidate.taxon.name || "organism";
    elements.image.src = imageUrl;
    elements.image.alt = `Observation photo for ${commonName}`;
    elements.image.hidden = false;
    elements.imagePlaceholder.hidden = true;
    elements.imageCredit.textContent = candidate.photos[0]?.attribution ?? "Observation photo via iNaturalist";
  } else {
    elements.image.removeAttribute("src");
    elements.image.hidden = true;
    elements.imagePlaceholder.hidden = false;
    elements.imageCredit.textContent = "";
  }

  elements.reject.disabled = false;
  elements.skip.disabled = false;
  elements.review.disabled = false;
  updateStats();
  hydrateCandidateTaxon(candidate);
}

function buildCandidateUrl() {
  if (identifierSearchActive()) {
    const params = new URLSearchParams({
      user_login: state.filters.identifierLogin,
      per_page: String(PAGE_SIZE),
      page: String(state.page),
      order_by: "created_at",
      order: "desc",
    });
    if (state.filters.taxonId) params.set("taxon_id", state.filters.taxonId);
    if (state.filters.placeId) params.set("place_id", state.filters.placeId);
    return `${IDENTIFICATIONS_URL}?${params}`;
  }

  if (ownerSearchActive()) {
    const params = new URLSearchParams({
      user_login: state.filters.ownerLogin,
      per_page: String(PAGE_SIZE),
      page: String(state.page),
      order_by: "updated_at",
      order: "desc",
    });
    if (state.filters.taxonId) params.set("taxon_id", state.filters.taxonId);
    if (state.filters.placeId) params.set("place_id", state.filters.placeId);
    return `${OBSERVATIONS_URL}?${params}`;
  }

  const params = new URLSearchParams({
    per_page: String(PAGE_SIZE),
    page: String(state.page),
    nominated: "false",
    fields: CANDIDATE_FIELDS,
  });

  if (state.filters.taxonId) params.set("taxon_id", state.filters.taxonId);
  if (state.filters.query) params.set("q", state.filters.query);
  return `${API_URL}?${params}`;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.filters.ownerLogin) params.set("owner", state.filters.ownerLogin);
  if (state.filters.identifierLogin) params.set("identifier", state.filters.identifierLogin);
  // Persist the chosen base taxon (not the expanded comma list) to keep URLs short.
  const taxonForUrl = state.filters.expand > 0 ? state.filters.baseTaxonId : state.filters.taxonId;
  if (taxonForUrl) params.set("taxon_id", taxonForUrl);
  if (state.filters.expand) params.set("expand", String(state.filters.expand));
  if (state.filters.placeId) params.set("place_id", state.filters.placeId);
  if (state.filters.language && state.filters.language !== "any") {
    params.set("language", state.filters.language);
  }
  if (state.filters.query) params.set("q", state.filters.query);
  if (state.filters.minimumWords !== 12) params.set("min_words", state.filters.minimumWords);
  const suffix = params.size ? `?${params}` : location.pathname;
  history.replaceState(null, "", suffix);
}

function matchesRemarkQuery(candidate) {
  const terms = state.filters.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const remark = candidate.remark.toLowerCase();
  return terms.every((term) => remark.includes(term));
}

function matchesLanguage(candidate) {
  return matchesLanguageFilter(state.filters.language, candidate.language);
}

// exemplar_identifications carries no place data and ignores place_id, so for a
// country filter we batch-fetch place_ids for the page's observations and keep
// only candidates whose observation falls inside the selected place.
async function filterByPlace(candidates) {
  if (!state.filters.placeId) return candidates;
  const placeId = Number(state.filters.placeId);
  const ids = [...new Set(candidates.map((c) => c.observationId).filter(Boolean))];
  if (!ids.length) return [];

  const params = new URLSearchParams({
    id: ids.join(","),
    per_page: String(ids.length),
    fields: "(id:!t,place_ids:!t)",
  });
  const response = await withTimeout(
    fetch(`https://api.inaturalist.org/v2/observations?${params}`, { signal: state.request.signal }),
    20000,
    "The iNaturalist place lookup timed out.",
  );
  if (!response.ok) throw new Error(`iNaturalist returned HTTP ${response.status}.`);
  const payload = await response.json();
  const placeMap = new Map(
    (payload.results ?? []).map((obs) => [obs.id, obs.place_ids ?? []]),
  );
  return candidates.filter((c) => (placeMap.get(c.observationId) ?? []).includes(placeId));
}

async function loadNextPage() {
  if (state.loading || !state.hasMore || state.loadedCount >= MAX_API_RECORDS) return;
  state.request = new AbortController();
  setView("card");
  setLoading(true);
  const sourceType = identifierSearchActive()
    ? "identifications"
    : ownerSearchActive()
      ? "observations"
      : "exemplar remarks";
  elements.queueLabel.textContent = `Loading ${sourceType} ${state.loadedCount + 1}–${Math.min(
    state.loadedCount + PAGE_SIZE,
    MAX_API_RECORDS,
  )}…`;
  elements.remark.textContent = "Reading identification remarks and ranking explanatory candidates…";

  try {
    const response = await withTimeout(
      fetch(buildCandidateUrl(), { signal: state.request.signal }),
      20000,
      "The iNaturalist request timed out.",
    );
    if (!response.ok) throw new Error(`iNaturalist returned HTTP ${response.status}.`);
    const payload = await response.json();
    const records = payload.results ?? [];
    state.loadedCount += records.length;
    state.page += 1;
    state.hasMore = records.length === PAGE_SIZE && state.loadedCount < MAX_API_RECORDS;
    let candidates = (identifierSearchActive()
      ? records.flatMap(normalizeIdentificationCandidates)
      : ownerSearchActive()
        ? records.flatMap(normalizeObservationCandidates)
        : records.map((record) => normalizeCandidate(record, {})))
      .filter(matchesRemarkQuery)
      .filter(matchesLanguage)
      .filter((candidate) => !state.decisions[candidate.id]);

    // Country filtering for the exemplar feed needs a secondary place lookup;
    // the owner and identifier feeds already constrain by place_id in-query.
    if (exemplarFeedActive()) candidates = await filterByPlace(candidates);

    state.queue.push(...rankCandidates(candidates, state.filters.minimumWords));
    syncUrl();
    renderCandidate();
  } catch (error) {
    if (error.name === "AbortError") return;
    setLoading(false);
    setView("error");
    elements.queueLabel.textContent = "Queue unavailable";
    elements.errorMessage.textContent = `${error.message} Check your connection, then try again.`;
  }
}

function loadQueue() {
  state.request?.abort();
  state.queue = [];
  state.cursor = 0;
  state.page = 1;
  state.loadedCount = 0;
  state.hasMore = true;
  loadNextPage();
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function advance() {
  state.cursor += 1;
  renderCandidate();
  elements.card.focus({ preventScroll: true });
}

function decide(decision) {
  const candidate = activeCandidate();
  if (!candidate || state.loading) return;

  if (decision === "review") {
    window.open(candidate.observationUrl, "_blank", "noopener,noreferrer");
  }

  state.history.push({ candidate, cursor: state.cursor });
  state.decisions[candidate.id] = { decision, at: new Date().toISOString() };
  writeDecisions();
  toast(
    decision === "review"
      ? "Opened the source observation. Nominate there if the remark holds up."
      : "Rejected locally. Nothing was sent to iNaturalist.",
  );
  advance();
}

function skip() {
  const candidate = activeCandidate();
  if (!candidate || state.loading) return;
  state.cursor += 1;
  renderCandidate();
  elements.card.focus({ preventScroll: true });
  toast("Skipped.");
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  delete state.decisions[last.candidate.id];
  writeDecisions();
  state.cursor = Math.max(0, last.cursor);
  state.queue[state.cursor] = last.candidate;
  renderCandidate();
  toast("Last local decision undone.");
}

function resetHistory() {
  if (!Object.keys(state.decisions).length) {
    toast("There are no saved decisions to reset.");
    return;
  }

  localStorage.removeItem(STORAGE_KEY);
  state.decisions = {};
  state.history = [];
  toast("Local review history cleared.");
  loadQueue();
}

// Resolve the descendant species of a family/genus, ranked by observation count.
async function expandTaxon(baseId, topN) {
  const params = new URLSearchParams({ taxon_id: String(baseId), per_page: String(topN) });
  const response = await withTimeout(
    fetch(`${SPECIES_COUNTS_URL}?${params}`),
    20000,
    "The taxon expansion request timed out.",
  );
  if (!response.ok) throw new Error(`iNaturalist returned HTTP ${response.status}.`);
  const payload = await response.json();
  return (payload.results ?? [])
    .map((row) => row.taxon?.id)
    .filter(Boolean)
    .join(",");
}

// Turn the chosen base taxon + expansion level into the literal taxon_id value
// (single id or comma list) we send to the candidate query.
async function resolveTaxonFilter() {
  const baseId = state.filters.baseTaxonId || state.filters.taxonId;
  if (state.filters.expand > 0 && /^\d+$/.test(baseId)) {
    try {
      const expanded = await expandTaxon(baseId, state.filters.expand);
      state.filters.taxonId = expanded || baseId;
    } catch {
      state.filters.taxonId = baseId; // fall back to the family/genus id itself
    }
  } else {
    state.filters.taxonId = baseId;
  }
}

async function applyFilters(event) {
  event?.preventDefault();
  closeSuggestions(elements.taxonSuggestions, elements.taxonSearch);
  closeSuggestions(elements.countrySuggestions, elements.countrySearch);
  state.filters = {
    ownerLogin: elements.observationOwner.value.trim().replace(/^@/, ""),
    identifierLogin: elements.identifier.value.trim().replace(/^@/, ""),
    taxonId: elements.taxonId.value.trim(),
    baseTaxonId: elements.taxonId.value.trim(),
    expand: Number(elements.taxonExpand.value) || 0,
    placeId: elements.countrySearch.dataset.placeId ?? "",
    placeName: elements.countrySearch.value.trim(),
    language: elements.tipLanguage.value || "any",
    query: elements.query.value.trim(),
    minimumWords: Number(elements.minimumWords.value),
  };
  await resolveTaxonFilter();
  loadQueue();
}

function restoreFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.ownerLogin = (params.get("owner") ?? "").replace(/^@/, "");
  state.filters.identifierLogin = (params.get("identifier") ?? "").replace(/^@/, "");
  state.filters.baseTaxonId = params.get("taxon_id") ?? "";
  state.filters.taxonId = state.filters.baseTaxonId;
  state.filters.expand = Number(params.get("expand") ?? 0) || 0;
  state.filters.placeId = params.get("place_id") ?? "";
  state.filters.language = params.get("language") ?? "any";
  state.filters.query = params.get("q") ?? "";
  state.filters.minimumWords = Number(params.get("min_words") ?? 12);
  elements.observationOwner.value = state.filters.ownerLogin;
  elements.identifier.value = state.filters.identifierLogin;
  elements.taxonId.value = state.filters.baseTaxonId;
  elements.taxonExpand.value = String(state.filters.expand);
  elements.tipLanguage.value = state.filters.language;
  elements.query.value = state.filters.query;
  elements.minimumWords.value = String(state.filters.minimumWords);
  if (state.filters.placeId) {
    elements.countrySearch.dataset.placeId = state.filters.placeId;
    hydratePlaceName(state.filters.placeId);
  }
}

// Initial queue load: expand the restored taxon filter (if any) before fetching.
async function initQueue() {
  await resolveTaxonFilter();
  loadQueue();
}

function closeSuggestions(listEl, input) {
  listEl.replaceChildren();
  listEl.hidden = true;
  if (input) input.setAttribute("aria-expanded", "false");
}

function renderSuggestions(listEl, input, items, onSelect) {
  listEl.replaceChildren();
  if (!items.length) {
    closeSuggestions(listEl, input);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "suggestion";
    li.setAttribute("role", "option");
    const primary = document.createElement("strong");
    primary.textContent = item.primary;
    li.append(primary);
    if (item.secondary) {
      const small = document.createElement("small");
      small.textContent = item.secondary;
      li.append(small);
    }
    // mousedown (not click) so selection runs before the input's blur closes the list.
    li.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onSelect(item);
      closeSuggestions(listEl, input);
    });
    listEl.append(li);
  }
  listEl.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function attachAutocomplete(input, listEl, fetchFn, onSelect, onInput) {
  let timer = null;
  input.addEventListener("input", () => {
    if (onInput) onInput();
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) {
      closeSuggestions(listEl, input);
      return;
    }
    timer = setTimeout(async () => {
      try {
        const items = await fetchFn(q);
        if (input.value.trim() === q) renderSuggestions(listEl, input, items, onSelect);
      } catch {
        closeSuggestions(listEl, input);
      }
    }, 250);
  });
  input.addEventListener("blur", () => setTimeout(() => closeSuggestions(listEl, input), 120));
}

async function searchTaxaSuggestions(q) {
  const params = new URLSearchParams({ q, limit: "10" });
  const response = await fetch(`${TREES_WORKER_URL}?${params}`);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.results ?? []).map((row) => ({
    id: row.taxon_id,
    primary: row.common_name ? `${row.name} — ${row.common_name}` : row.name,
    secondary: row.rank,
  }));
}

async function searchPlaceSuggestions(q) {
  const params = new URLSearchParams({ q, per_page: "10" });
  const response = await fetch(`${PLACES_AUTOCOMPLETE_URL}?${params}`);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.results ?? [])
    .sort((a, b) => (a.admin_level ?? 99) - (b.admin_level ?? 99))
    .map((row) => ({
      id: row.id,
      primary: row.display_name,
      secondary: row.admin_level === 0 ? "country" : `admin level ${row.admin_level ?? "?"}`,
    }));
}

async function hydratePlaceName(id) {
  try {
    const response = await fetch(`https://api.inaturalist.org/v1/places/${id}`);
    if (!response.ok) return;
    const data = await response.json();
    const name = data.results?.[0]?.display_name;
    if (name && !elements.countrySearch.value) elements.countrySearch.value = name;
  } catch {
    /* best-effort label only */
  }
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

attachAutocomplete(
  elements.taxonSearch,
  elements.taxonSuggestions,
  searchTaxaSuggestions,
  (item) => {
    elements.taxonId.value = item.id;
    elements.taxonSearch.value = item.primary;
  },
);
attachAutocomplete(
  elements.countrySearch,
  elements.countrySuggestions,
  searchPlaceSuggestions,
  (item) => {
    elements.countrySearch.dataset.placeId = String(item.id);
    elements.countrySearch.value = item.primary;
  },
  () => delete elements.countrySearch.dataset.placeId,
);

elements.form.addEventListener("submit", applyFilters);
elements.reject.addEventListener("click", () => decide("reject"));
elements.review.addEventListener("click", () => decide("review"));
elements.skip.addEventListener("click", skip);
elements.undo.addEventListener("click", undo);
elements.retry.addEventListener("click", loadQueue);
elements.reset.addEventListener("click", resetHistory);
elements.openShortcuts.addEventListener("click", () => elements.shortcuts.showModal());
elements.closeShortcuts.addEventListener("click", () => elements.shortcuts.close());
elements.shortcuts.addEventListener("click", (event) => {
  if (event.target === elements.shortcuts) elements.shortcuts.close();
});

document.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "?" && !elements.shortcuts.open) {
    event.preventDefault();
    elements.shortcuts.showModal();
  } else if (key === "n") {
    event.preventDefault();
    decide("review");
  } else if (key === "r") {
    event.preventDefault();
    decide("reject");
  } else if (key === "s") {
    event.preventDefault();
    skip();
  } else if (key === "u") {
    event.preventDefault();
    undo();
  }
});

elements.image.addEventListener("error", () => {
  elements.image.hidden = true;
  elements.imagePlaceholder.hidden = false;
  elements.imageCredit.textContent = "";
});

restoreFiltersFromUrl();
updateStats();
initQueue();
