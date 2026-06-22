import {
  normalizeCandidate,
  normalizeObservationCandidates,
  rankCandidates,
} from "./ranking.js";
import {
  appendReviewRow,
  createReviewRow,
  toCsv,
} from "./review-log.js";

const API_URL = "https://api.inaturalist.org/v2/exemplar_identifications";
const OBSERVATIONS_URL = "https://api.inaturalist.org/v1/observations";
const TAXA_URL = "https://api.inaturalist.org/v2/taxa";
const STORAGE_KEY = "inat-id-tip-review-decisions-v1";
const LOG_STORAGE_KEY = "inat-id-tip-review-log-v1";
const SYNC_KEY_STORAGE = "inat-id-tip-review-sync-key-v1";
const SYNC_ENDPOINT = "https://inat-id-tips-review.intrinsic3141.workers.dev/reviews";
const PAGE_SIZE = 50;
const MAX_API_RECORDS = 1000;
const SYNC_BATCH_SIZE = 100;
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
  taxonId: document.querySelector("#taxon-id"),
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
  downloadCsv: document.querySelector("#download-csv"),
  syncStatus: document.querySelector("#sync-status"),
  syncDialog: document.querySelector("#sync-dialog"),
  openSync: document.querySelector("#open-sync"),
  closeSync: document.querySelector("#close-sync"),
  syncKey: document.querySelector("#sync-key"),
  saveSyncKey: document.querySelector("#save-sync-key"),
  syncNow: document.querySelector("#sync-now"),
  syncDialogStatus: document.querySelector("#sync-dialog-status"),
  reviewedCount: document.querySelector("#reviewed-count"),
  rejectedCount: document.querySelector("#rejected-count"),
  remainingCount: document.querySelector("#remaining-count"),
  shortcuts: document.querySelector("#shortcuts-dialog"),
  openShortcuts: document.querySelector("#open-shortcuts"),
  closeShortcuts: document.querySelector("#close-shortcuts"),
  toast: document.querySelector("#toast"),
};

const state = {
  queue: [],
  cursor: 0,
  decisions: readDecisions(),
  reviewLog: readReviewLog(),
  history: [],
  loading: false,
  request: null,
  page: 1,
  loadedCount: 0,
  hasMore: true,
  syncing: false,
  syncError: "",
  logPersistError: false,
  syncTimer: null,
  taxonCache: new Map(),
  filters: {
    ownerLogin: "",
    taxonId: "",
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

function readReviewLog() {
  try {
    const rows = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) ?? "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeReviewLog() {
  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(state.reviewLog));
    state.logPersistError = false;
  } catch (error) {
    // localStorage is capped (~5 MB per origin). The in-memory log keeps every
    // row so CSV export and repository sync stay complete; we just can't persist
    // across reloads once the browser quota is hit. Never let this break review.
    state.logPersistError = true;
    console.warn("Review log no longer fits in localStorage; relying on sync + CSV export.", error);
  }
}

function syncKey() {
  return sessionStorage.getItem(SYNC_KEY_STORAGE) ?? "";
}

function updateStats() {
  const decisions = Object.values(state.decisions);
  const pending = state.reviewLog.filter((row) => !row.synced_at).length;
  elements.reviewedCount.textContent = decisions.filter((item) => item.decision === "review").length;
  elements.rejectedCount.textContent = decisions.filter((item) => item.decision === "reject").length;
  elements.remainingCount.textContent = state.loading
    ? "—"
    : Math.max(0, state.queue.length - state.cursor);
  elements.undo.disabled = state.history.length === 0;
  elements.downloadCsv.disabled = state.reviewLog.length === 0;
  elements.syncStatus.classList.toggle("is-connected", Boolean(syncKey()) && !state.syncing);
  elements.syncStatus.classList.toggle("is-error", Boolean(state.syncError) || state.logPersistError);
  const rows = `${state.reviewLog.length.toLocaleString()} rows`;
  const detail = state.syncing
    ? `syncing ${pending}`
    : state.syncError
      ? "sync error"
      : state.logPersistError
        ? "local save full · export CSV"
        : syncKey()
          ? `${pending} pending`
          : "repository not connected";
  elements.syncStatus.textContent = `${rows} · ${detail}`;
}

function recordAction(candidate, action) {
  const row = { ...createReviewRow(candidate, action), synced_at: null };
  state.reviewLog = appendReviewRow(state.reviewLog, row);
  writeReviewLog();
  updateStats();
  scheduleSync();
  return row.event_id;
}

function backfillTaxonLog(candidate) {
  if (!candidate.taxon?.name) return;
  let changed = false;
  state.reviewLog = state.reviewLog.map((row) => {
    if (String(row.taxon_id) !== String(candidate.taxonId) || row.species_name) return row;
    changed = true;
    return {
      ...row,
      species_name: candidate.taxon.name,
      common_name: candidate.taxon.preferred_common_name ?? "",
      synced_at: null,
    };
  });
  if (changed) {
    writeReviewLog();
    scheduleSync();
  }
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

function ownerSearchActive() {
  return Boolean(state.filters.ownerLogin);
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
  backfillTaxonLog(candidate);
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
  const sourceLabel = ownerSearchActive()
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
  if (ownerSearchActive()) {
    const params = new URLSearchParams({
      user_login: state.filters.ownerLogin,
      per_page: String(PAGE_SIZE),
      page: String(state.page),
      order_by: "updated_at",
      order: "desc",
    });
    if (state.filters.taxonId) params.set("taxon_id", state.filters.taxonId);
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
  if (state.filters.taxonId) params.set("taxon_id", state.filters.taxonId);
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

async function loadNextPage() {
  if (state.loading || !state.hasMore || state.loadedCount >= MAX_API_RECORDS) return;
  state.request = new AbortController();
  setView("card");
  setLoading(true);
  const sourceType = ownerSearchActive() ? "observations" : "exemplar remarks";
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
    const candidates = (ownerSearchActive()
      ? records.flatMap(normalizeObservationCandidates)
      : records.map((record) => normalizeCandidate(record, {})))
      .filter(matchesRemarkQuery)
      .filter((candidate) => !state.decisions[candidate.id]);

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

function scheduleSync(delay) {
  if (!syncKey() || state.syncing) return;
  const pending = state.reviewLog.filter((row) => !row.synced_at).length;
  if (!pending) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(syncPending, delay ?? (pending >= 25 ? 2000 : 30000));
}

async function syncPending() {
  const key = syncKey();
  const pending = state.reviewLog.filter((row) => !row.synced_at).slice(0, SYNC_BATCH_SIZE);
  if (!key) {
    elements.syncDialogStatus.textContent = "Enter the Worker submission key before syncing.";
    elements.syncKey.focus();
    return;
  }
  if (!pending.length || state.syncing) return;

  state.syncing = true;
  updateStats();
  elements.syncDialogStatus.textContent = `Syncing ${pending.length} row${pending.length === 1 ? "" : "s"}…`;

  try {
    state.syncError = "";
    const response = await withTimeout(
      fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-review-key": key },
        body: JSON.stringify({ rows: pending }),
      }),
      30000,
      "Repository sync timed out.",
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `Repository sync returned ${response.status}`);

    const syncedIds = new Set(pending.map((row) => row.event_id));
    const syncedAt = new Date().toISOString();
    state.reviewLog = state.reviewLog.map((row) =>
      syncedIds.has(row.event_id) ? { ...row, synced_at: syncedAt } : row,
    );
    writeReviewLog();
    elements.syncDialogStatus.textContent = `${payload.saved} rows saved; ${payload.total} rows are now in the repository CSV.`;
    toast(`${payload.saved} review rows synced to the repository.`);
  } catch (error) {
    state.syncError = error.message;
    elements.syncDialogStatus.textContent = error.message;
    toast(`Repository sync failed: ${error.message}`);
  } finally {
    state.syncing = false;
    updateStats();
    if (state.reviewLog.some((row) => !row.synced_at)) scheduleSync(2000);
  }
}

function saveSyncKey() {
  const key = elements.syncKey.value.trim();
  if (!key) {
    elements.syncDialogStatus.textContent = "A submission key is required.";
    return;
  }
  sessionStorage.setItem(SYNC_KEY_STORAGE, key);
  state.syncError = "";
  elements.syncKey.value = "";
  elements.syncDialogStatus.textContent = "Connected for this browser tab. Syncing pending rows…";
  updateStats();
  syncPending();
}

function downloadCsv() {
  if (!state.reviewLog.length) return;
  const blob = new Blob([toCsv(state.reviewLog)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inat-id-tip-review-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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

  const logEventId = recordAction(candidate, decision === "review" ? "N" : "R");
  state.history.push({ candidate, cursor: state.cursor, logEventId });
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
  recordAction(candidate, "S");
  state.cursor += 1;
  renderCandidate();
  elements.card.focus({ preventScroll: true });
  toast("Skip recorded in the review log.");
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  delete state.decisions[last.candidate.id];
  writeDecisions();
  state.reviewLog = state.reviewLog.filter((row) => row.event_id !== last.logEventId);
  writeReviewLog();
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

function applyFilters(event) {
  event?.preventDefault();
  state.filters = {
    ownerLogin: elements.observationOwner.value.trim().replace(/^@/, ""),
    taxonId: elements.taxonId.value.trim(),
    query: elements.query.value.trim(),
    minimumWords: Number(elements.minimumWords.value),
  };
  loadQueue();
}

function restoreFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  state.filters.ownerLogin = (params.get("owner") ?? "").replace(/^@/, "");
  state.filters.taxonId = params.get("taxon_id") ?? "";
  state.filters.query = params.get("q") ?? "";
  state.filters.minimumWords = Number(params.get("min_words") ?? 12);
  elements.observationOwner.value = state.filters.ownerLogin;
  elements.taxonId.value = state.filters.taxonId;
  elements.query.value = state.filters.query;
  elements.minimumWords.value = String(state.filters.minimumWords);
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

elements.form.addEventListener("submit", applyFilters);
elements.reject.addEventListener("click", () => decide("reject"));
elements.review.addEventListener("click", () => decide("review"));
elements.skip.addEventListener("click", skip);
elements.undo.addEventListener("click", undo);
elements.retry.addEventListener("click", loadQueue);
elements.reset.addEventListener("click", resetHistory);
elements.downloadCsv.addEventListener("click", downloadCsv);
elements.openSync.addEventListener("click", () => elements.syncDialog.showModal());
elements.closeSync.addEventListener("click", () => elements.syncDialog.close());
elements.saveSyncKey.addEventListener("click", saveSyncKey);
elements.syncNow.addEventListener("click", syncPending);
elements.openShortcuts.addEventListener("click", () => elements.shortcuts.showModal());
elements.closeShortcuts.addEventListener("click", () => elements.shortcuts.close());
elements.shortcuts.addEventListener("click", (event) => {
  if (event.target === elements.shortcuts) elements.shortcuts.close();
});
elements.syncDialog.addEventListener("click", (event) => {
  if (event.target === elements.syncDialog) elements.syncDialog.close();
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
loadQueue();
scheduleSync(2000);
  elements.observationOwner.value = state.filters.ownerLogin;
