import { CSV_COLUMNS, toCsv } from "../../src/review-log.js";

const REVIEW_PATH = "data/reviews.csv";
const MAX_BATCH_ROWS = 100;
const GITHUB_API_VERSION = "2022-11-28";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigin(origin, configuredOrigin) {
  if (!origin) return false;
  if (origin === configuredOrigin) return true;
  return /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
}

function corsHeaders(origin, configuredOrigin) {
  if (!allowedOrigin(origin, configuredOrigin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-review-key",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(String(left ?? ""));
  const b = new TextEncoder().encode(String(right ?? ""));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^ (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

function fromBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

export function parseCsv(csv) {
  const lines = String(csv).replace(/^\ufeff/, "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function plainCell(value, maxLength = 500) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
}

export function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH_ROWS) {
    throw new Error(`rows must contain between 1 and ${MAX_BATCH_ROWS} records`);
  }

  return rows.map((row) => {
    const normalized = Object.fromEntries(
      CSV_COLUMNS.map((column) => [column, plainCell(row?.[column])]),
    );
    if (!/^[NRS]$/.test(normalized.action)) throw new Error("action must be N, R, or S");
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(normalized.event_id)) throw new Error("invalid event_id");
    if (!/^https:\/\/www\.inaturalist\.org\/observations\/\d+/.test(normalized.observation_url)) {
      throw new Error("invalid observation_url");
    }
    return normalized;
  });
}

export function mergeRows(existingRows, incomingRows) {
  const merged = new Map();
  [...existingRows, ...incomingRows].forEach((row) => {
    if (row.event_id) merged.set(row.event_id, row);
  });
  return [...merged.values()]
    .sort((left, right) => String(left.recorded_at).localeCompare(String(right.recorded_at)));
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "iNat-ID-tips-review-worker",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function readReviewFile(env) {
  const path = encodeURIComponent(REVIEW_PATH).replaceAll("%2F", "/");
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const response = await fetch(url, { headers: githubHeaders(env.GITHUB_TOKEN) });
  if (response.status === 404) return { rows: [], sha: null };
  if (!response.ok) throw new Error(`GitHub read failed with ${response.status}`);
  const payload = await response.json();
  return { rows: parseCsv(fromBase64Utf8(payload.content)), sha: payload.sha };
}

async function writeReviewFile(env, rows, sha) {
  const path = encodeURIComponent(REVIEW_PATH).replaceAll("%2F", "/");
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message: `Record ${rows.length} ID tip review actions`,
    branch: env.GITHUB_BRANCH,
    content: toBase64Utf8(toCsv(rows)),
  };
  if (sha) body.sha = sha;

  return fetch(url, {
    method: "PUT",
    headers: { ...githubHeaders(env.GITHUB_TOKEN), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function persistRows(env, incomingRows) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readReviewFile(env);
    const merged = mergeRows(current.rows, incomingRows);
    const response = await writeReviewFile(env, merged, current.sha);
    if (response.ok) {
      const payload = await response.json();
      return {
        saved: incomingRows.length,
        total: merged.length,
        commit_url: payload.commit?.html_url ?? null,
      };
    }
    if (![409, 422].includes(response.status) || attempt === 2) {
      throw new Error(`GitHub write failed with ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error("GitHub write did not complete");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") ?? "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      if (!Object.keys(cors).length) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, repository: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` });
    }

    if (url.pathname !== "/reviews" || request.method !== "POST") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (!Object.keys(cors).length) return json({ error: "Origin not allowed" }, 403);
    if (!env.GITHUB_TOKEN || !env.SUBMISSION_KEY) {
      return json({ error: "Worker secrets are not configured" }, 503, cors);
    }
    if (!timingSafeEqual(request.headers.get("x-review-key"), env.SUBMISSION_KEY)) {
      return json({ error: "Invalid review key" }, 401, cors);
    }

    try {
      const payload = await request.json();
      const rows = normalizeRows(payload.rows);
      const result = await persistRows(env, rows);
      return json(result, 200, cors);
    } catch (error) {
      const isValidationError = /rows|action|event_id|observation_url/.test(error.message);
      return json({ error: error.message }, isValidationError ? 400 : 502, cors);
    }
  },
};
