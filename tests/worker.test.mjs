import test from "node:test";
import assert from "node:assert/strict";

import { mergeRows, normalizeRows, parseCsv, parseCsvLine } from "../worker/src/index.js";
import { createReviewRow, toCsv } from "../src/review-log.js";

const candidate = {
  id: 42,
  identificationId: 99,
  observationId: 123,
  observationUrl: "https://www.inaturalist.org/observations/123#identification-99",
  taxonId: 7,
  taxon: { name: "Example species", preferred_common_name: "Common, quoted" },
};

test("parseCsvLine handles commas and escaped quotes", () => {
  assert.deepEqual(parseCsvLine('"one","two, parts","three ""quoted"""'), [
    "one",
    "two, parts",
    'three "quoted"',
  ]);
});

test("worker CSV parser round-trips review rows", () => {
  const row = createReviewRow(candidate, "N", "2026-06-22T12:00:00.000Z");
  const parsed = parseCsv(toCsv([row]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].event_id, row.event_id);
  assert.equal(parsed[0].common_name, "Common, quoted");
});

test("normalizeRows rejects unexpected actions and unsafe URLs", () => {
  const row = createReviewRow(candidate, "R");
  assert.throws(() => normalizeRows([{ ...row, action: "X" }]), /action/);
  assert.throws(() => normalizeRows([{ ...row, observation_url: "https://example.com" }]), /observation_url/);
});

test("mergeRows is idempotent and keeps the newest version", () => {
  const row = createReviewRow(candidate, "S", "2026-06-22T12:00:00.000Z");
  const result = mergeRows([row], [{ ...row, action: "N" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, "N");
});
