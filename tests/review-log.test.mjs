import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REVIEW_LOG_ROWS,
  appendReviewRow,
  createReviewRow,
  toCsv,
} from "../src/review-log.js";

const candidate = {
  id: 42,
  identificationId: 99,
  observationId: 123,
  observationUrl: "https://www.inaturalist.org/observations/123#identification-99",
  taxonId: 7,
  taxon: { name: "Example species", preferred_common_name: "Example common name" },
};

test("createReviewRow records the requested identifiers and names", () => {
  const row = createReviewRow(candidate, "N", "2026-06-22T12:00:00.000Z");
  assert.equal(row.action, "N");
  assert.equal(row.exemplar_identification_id, 42);
  assert.equal(row.identification_id, 99);
  assert.equal(row.observation_id, 123);
  assert.equal(row.taxon_id, 7);
  assert.equal(row.species_name, "Example species");
  assert.equal(row.common_name, "Example common name");
  assert.equal(row.recorded_at, "2026-06-22T12:00:00.000Z");
  assert.ok(row.event_id);
});

test("createReviewRow accepts only N, R, and S", () => {
  assert.throws(() => createReviewRow(candidate, "X"), /Unsupported review action/);
});

test("appendReviewRow keeps only the newest 1000 rows", () => {
  const rows = Array.from({ length: MAX_REVIEW_LOG_ROWS }, (_, index) => ({ event_id: index }));
  const result = appendReviewRow(rows, { event_id: MAX_REVIEW_LOG_ROWS });
  assert.equal(result.length, MAX_REVIEW_LOG_ROWS);
  assert.equal(result[0].event_id, 1);
  assert.equal(result.at(-1).event_id, MAX_REVIEW_LOG_ROWS);
});

test("toCsv emits Excel-friendly UTF-8 CSV with escaping and formula protection", () => {
  const row = {
    ...createReviewRow(candidate, "S", "2026-06-22T12:00:00.000Z"),
    species_name: 'Species "quoted"',
    common_name: "=unsafe formula",
  };
  const csv = toCsv([row]);
  assert.ok(csv.startsWith("\ufeff\"event_id\",\"action\""));
  assert.match(csv, /\"Species \"\"quoted\"\"\"/);
  assert.match(csv, /\"'=unsafe formula\"/);
  assert.match(csv, /\"S\"/);
});
