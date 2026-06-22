import test from "node:test";
import assert from "node:assert/strict";

import {
  detectLanguage,
  matchesLanguageFilter,
  LANGUAGE_LABELS,
} from "../src/language.js";

test("detects major Latin-script languages from representative sentences", () => {
  assert.equal(
    detectLanguage("The bill shape and the dark wings separate this from a Rook."),
    "en",
  );
  assert.equal(
    detectLanguage("Se puede distinguir esta especie por la forma del pico y las alas más oscuras."),
    "es",
  );
  assert.equal(
    detectLanguage("On peut distinguer cette espèce par la forme du bec qui est plus sombre."),
    "fr",
  );
  assert.equal(
    detectLanguage("Diese Art ist nicht der Rabe, das erkennt man an der Form und den Flügeln."),
    "de",
  );
  assert.equal(
    detectLanguage("Esta espécie não é o corvo, dá para ver pela forma das asas mais escuras."),
    "pt",
  );
});

test("detects non-Latin scripts by Unicode range", () => {
  assert.equal(detectLanguage("Это не ворон, обратите внимание на форму клюва."), "ru");
  assert.equal(detectLanguage("これはカラスではありません。"), "ja");
  assert.equal(detectLanguage("这不是乌鸦，请注意喙的形状。"), "zh");
  assert.equal(detectLanguage("이것은 까마귀가 아닙니다."), "ko");
});

test("returns 'other' for empty or unplaceable text", () => {
  assert.equal(detectLanguage(""), "other");
  assert.equal(detectLanguage("   "), "other");
  assert.equal(detectLanguage("xyzzy qwerty"), "other");
});

test("matchesLanguageFilter: any matches everything, other excludes named Latin langs", () => {
  assert.equal(matchesLanguageFilter("any", "ru"), true);
  assert.equal(matchesLanguageFilter("", "fr"), true);
  assert.equal(matchesLanguageFilter("en", "en"), true);
  assert.equal(matchesLanguageFilter("en", "fr"), false);
  assert.equal(matchesLanguageFilter("other", "ru"), true);
  assert.equal(matchesLanguageFilter("other", "en"), false);
});

test("every detectable code has a label", () => {
  for (const code of ["en", "es", "fr", "de", "pt", "it", "nl", "ru", "other"]) {
    assert.ok(LANGUAGE_LABELS[code], `missing label for ${code}`);
  }
});
