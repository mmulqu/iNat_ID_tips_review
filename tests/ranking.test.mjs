import test from "node:test";
import assert from "node:assert/strict";

import {
  buildObservationUrl,
  classifyRemark,
  cleanRemark,
  countWords,
  normalizeCandidate,
  rankCandidates,
  scoreCandidate,
} from "../src/ranking.js";

test("cleanRemark removes markup, URLs, and decodes entities", () => {
  const remark = 'Note the <strong>white cell</strong> &amp; black margin. <a href="x">Guide</a> https://example.com';
  assert.equal(cleanRemark(remark), "Note the white cell & black margin. Guide");
});

test("countWords ignores HTML structure", () => {
  assert.equal(countWords("One <em>two</em> three<br>four"), 4);
});

test("diagnostic contrastive remarks outrank boilerplate", () => {
  const diagnostic = {
    remark:
      "This differs from the similar species because the outer wing margin has two white spots; look for the broad black vein.",
    identifier: { identifications_count: 12000 },
    photoCount: 2,
  };
  const boilerplate = {
    remark: "Welcome to iNaturalist and thanks for sharing this really nice find with everyone here today.",
    identifier: { identifications_count: 12000 },
    photoCount: 2,
  };

  assert.ok(scoreCandidate(diagnostic) > scoreCandidate(boilerplate));
  assert.ok(scoreCandidate(diagnostic) >= 60);
});

test("classifyRemark identifies contrastive and visual information", () => {
  const tags = classifyRemark(
    "This can be distinguished from the similar species because the wing has a white stripe.",
  );
  assert.deepEqual(tags, ["contrastive ID", "diagnostic detail", "visual cue"]);
});

test("rankCandidates applies minimum word count and descending score", () => {
  const candidates = [
    { id: 1, remark: "Too short", wordCount: 2, identifier: {}, photoCount: 0 },
    {
      id: 2,
      remark: "This is a useful long description with enough ordinary words to remain in the review queue today.",
      wordCount: 16,
      identifier: {},
      photoCount: 0,
    },
    {
      id: 3,
      remark:
        "This differs from the similar species because the wing margin has a diagnostic white spot visible in the photo.",
      wordCount: 18,
      identifier: { identifications_count: 5000 },
      photoCount: 1,
    },
  ];

  const ranked = rankCandidates(candidates, 12);
  assert.deepEqual(
    ranked.map((candidate) => candidate.id),
    [3, 2],
  );
});

test("normalizeCandidate maps the V2 resource without treating it as a published tip", () => {
  const candidate = normalizeCandidate(
    {
      id: 42,
      cached_votes_total: 0,
      identification: {
        id: 99,
        body: "Note the diagnostic wing margin because it separates this from the similar species in the field.",
        taxon: { id: 7 },
        user: { id: 5, login: "identifier" },
        observation: { id: 123, photos: [{ url: "https://example.com/square.jpg" }] },
      },
    },
    { id: 7, name: "Example species" },
  );

  assert.equal(candidate.id, 42);
  assert.equal(candidate.taxon.name, "Example species");
  assert.equal(candidate.observationUrl, "https://www.inaturalist.org/observations/123#identification-99");
  assert.equal(candidate.photos.length, 1);
});

test("buildObservationUrl safely handles missing observations", () => {
  assert.equal(buildObservationUrl(null, 2), "https://www.inaturalist.org");
  assert.equal(
    buildObservationUrl(100, 200),
    "https://www.inaturalist.org/observations/100#identification-200",
  );
});
