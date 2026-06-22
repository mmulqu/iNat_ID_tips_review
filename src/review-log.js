export const CSV_COLUMNS = [
  "event_id",
  "action",
  "observation_url",
  "exemplar_identification_id",
  "identification_id",
  "observation_id",
  "observation_owner",
  "taxon_id",
  "species_name",
  "common_name",
  "recorded_at",
];

function eventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createReviewRow(candidate, action, recordedAt = new Date().toISOString()) {
  if (!["N", "R", "S"].includes(action)) {
    throw new Error(`Unsupported review action: ${action}`);
  }

  return {
    event_id: eventId(),
    action,
    observation_url: candidate.observationUrl ?? "",
    exemplar_identification_id: candidate.exemplarIdentificationId ?? candidate.id ?? "",
    identification_id: candidate.identificationId ?? "",
    observation_id: candidate.observationId ?? "",
    observation_owner: candidate.observationOwner ?? "",
    taxon_id: candidate.taxonId ?? "",
    species_name: candidate.taxon?.name ?? "",
    common_name: candidate.taxon?.preferred_common_name ?? "",
    recorded_at: recordedAt,
  };
}

export function appendReviewRow(rows, row, limit = null) {
  if (limit === null) return [...rows, row];
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Review log limit must be positive");
  return [...rows, row].slice(-limit);
}

function safeCell(value) {
  const text = String(value ?? "");
  const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export function toCsv(rows) {
  const header = CSV_COLUMNS.map(safeCell).join(",");
  const body = rows.map((row) => CSV_COLUMNS.map((column) => safeCell(row[column])).join(","));
  return `\ufeff${[header, ...body].join("\r\n")}\r\n`;
}
