// Lightweight, dependency-free language detection for short identification tips.
//
// iNaturalist identifications carry no language field, so we infer one from the
// remark text. Two stages: (1) non-Latin scripts are detected by Unicode range,
// (2) Latin-script text is scored against small function-word sets for the
// languages the UI offers. Detection on short text is necessarily approximate;
// the value is shown on each card so the reviewer can see what was guessed.

// Languages selectable as named filters. Anything detected outside this set
// (non-Latin scripts, or Latin text we can't pin down) is bucketed as "other".
export const LATIN_LANGUAGES = ["en", "es", "fr", "de", "pt", "it", "nl"];

export const LANGUAGE_LABELS = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  el: "Greek",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  he: "Hebrew",
  th: "Thai",
  hi: "Hindi",
  other: "Other",
};

const SCRIPT_RANGES = [
  ["ru", /[Ѐ-ӿ]/],
  ["el", /[Ͱ-Ͽ]/],
  ["ja", /[぀-ヿ]/], // hiragana/katakana checked before han
  ["ko", /[가-힯]/],
  ["zh", /[一-鿿]/],
  ["ar", /[؀-ۿ]/],
  ["he", /[֐-׿]/],
  ["th", /[฀-๿]/],
  ["hi", /[ऀ-ॿ]/],
];

// Distinctive function words per language. Overlaps between Romance languages
// are unavoidable; scoring picks the best match and ties break by STOPWORDS order.
const STOPWORDS = {
  en: ["the", "and", "is", "are", "this", "that", "with", "from", "not", "you", "for", "can", "has", "have", "but", "which", "your", "look", "than", "they", "its"],
  es: ["el", "la", "los", "las", "una", "que", "con", "por", "para", "como", "pero", "está", "este", "esta", "son", "más", "tiene", "según", "donde", "uno"],
  fr: ["le", "les", "des", "une", "est", "que", "qui", "avec", "pour", "dans", "pas", "sur", "mais", "plus", "cette", "sont", "vous", "aux", "ces", "être"],
  de: ["der", "die", "das", "und", "ist", "ein", "eine", "nicht", "mit", "auf", "für", "den", "dem", "sich", "auch", "aber", "sind", "wird", "durch", "noch"],
  pt: ["não", "uma", "com", "por", "para", "como", "mas", "mais", "está", "este", "esta", "são", "sua", "dos", "das", "também", "pela", "isso", "muito"],
  it: ["il", "che", "non", "una", "con", "per", "come", "questo", "questa", "sono", "del", "della", "gli", "nel", "anche", "più", "essere", "alla", "dei"],
  nl: ["het", "een", "niet", "met", "voor", "van", "op", "dat", "deze", "zijn", "maar", "ook", "je", "wordt", "naar", "bij", "zoals", "kan", "heeft"],
};

function detectScript(text) {
  for (const [code, range] of SCRIPT_RANGES) {
    if (range.test(text)) return code;
  }
  return null;
}

function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}]+/gu) ?? []);
}

/**
 * Detect the language of a tip. Returns an ISO-ish code from LANGUAGE_LABELS,
 * or "other" when the text is too short/ambiguous to place.
 */
export function detectLanguage(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return "other";

  const script = detectScript(raw);
  if (script) return script;

  const tokens = tokenize(raw);
  if (!tokens.length) return "other";
  const present = new Set(tokens);

  let best = null;
  let bestScore = 0;
  for (const code of LATIN_LANGUAGES) {
    let score = 0;
    for (const word of STOPWORDS[code]) if (present.has(word)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }

  if (bestScore >= 2) return best;
  // Plain Latin text with no strong signal: iNat tips skew English. A single
  // English hit nudges it to English; otherwise leave it unclassified.
  if (best === "en" && bestScore >= 1) return "en";
  return "other";
}

/**
 * Does a detected language satisfy the selected filter value?
 * "any" matches everything; "other" matches anything outside the named Latin set.
 */
export function matchesLanguageFilter(filterValue, detected) {
  if (!filterValue || filterValue === "any") return true;
  if (filterValue === "other") return !LATIN_LANGUAGES.includes(detected);
  return detected === filterValue;
}
