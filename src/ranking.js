import { detectLanguage } from "./language.js";

const DIAGNOSTIC_PATTERNS = [
  /\bdiffers? from\b/i,
  /\bcan be (?:separated|distinguished)\b/i,
  /\bkey (?:feature|character|difference)\b/i,
  /\bdiagnostic\b/i,
  /\bnote (?:the|that)\b/i,
  /\blook for\b/i,
  /\bidentified by\b/i,
  /\bbecause\b/i,
];

const CONTRAST_PATTERNS = [
  /\brather than\b/i,
  /\bnot .{1,45} because\b/i,
  /\bversus\b/i,
  /\bconfused with\b/i,
  /\bsimilar (?:to|species)\b/i,
];

const EVIDENCE_PATTERNS = [
  /\b(?:color|colour|shape|stripe|spot|margin|vein|wing|leaf|stem|flower|hair|scale|bill|tail|call|song)\b/i,
  /\b(?:range|region|habitat|season|month|elevation|host)\b/i,
  /\b(?:dorsal|ventral|anterior|posterior|lateral)\b/i,
];

const BOILERPLATE_PATTERNS = [
  /\bwelcome to (?:iNaturalist|iNat)\b/i,
  /^\s*(?:thanks|thank you|nice find|great find|cool|agree)[!.\s]*$/i,
  /\bplease add (?:a )?(?:location|photo)\b/i,
];

export function cleanRemark(value = "") {
  const withoutMarkup = String(value)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");

  const textarea = typeof document !== "undefined" ? document.createElement("textarea") : null;
  if (textarea) {
    textarea.innerHTML = withoutMarkup;
    return textarea.value.replace(/\s+/g, " ").trim();
  }

  return withoutMarkup
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function countWords(value = "") {
  const cleaned = cleanRemark(value);
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

function patternHits(text, patterns) {
  return patterns.reduce((total, pattern) => total + Number(pattern.test(text)), 0);
}

export function classifyRemark(value = "") {
  const text = cleanRemark(value);
  const tags = [];

  if (patternHits(text, CONTRAST_PATTERNS)) tags.push("contrastive ID");
  if (patternHits(text, DIAGNOSTIC_PATTERNS)) tags.push("diagnostic detail");
  if (/\b(?:range|region|elevation|season|month|habitat|host)\b/i.test(text)) {
    tags.push("range / ecology");
  }
  if (/\b(?:call|song|sound|audio|note)\b/i.test(text)) tags.push("sound cue");
  if (/\b(?:photo|image|visible|see|look|color|colour|shape|stripe|spot|wing|leaf|flower)\b/i.test(text)) {
    tags.push("visual cue");
  }

  return tags.slice(0, 3);
}

export function scoreCandidate(candidate) {
  const text = cleanRemark(candidate.remark ?? candidate.identification?.body ?? "");
  const words = countWords(text);
  const diagnosticHits = patternHits(text, DIAGNOSTIC_PATTERNS);
  const contrastHits = patternHits(text, CONTRAST_PATTERNS);
  const evidenceHits = patternHits(text, EVIDENCE_PATTERNS);
  const boilerplateHits = patternHits(text, BOILERPLATE_PATTERNS);
  const identificationCount = Number(candidate.identifier?.identifications_count ?? 0);
  const photoCount = Number(candidate.photoCount ?? candidate.photos?.length ?? 0);

  let score = 0;
  if (words >= 12 && words <= 150) score += 22;
  else if (words >= 8 && words <= 220) score += 10;
  if (words >= 22 && words <= 90) score += 8;
  score += Math.min(diagnosticHits * 9, 27);
  score += Math.min(contrastHits * 12, 24);
  score += Math.min(evidenceHits * 6, 18);
  score += Math.min(Math.log10(identificationCount + 1) * 3, 12);
  score += Math.min(photoCount * 2, 6);
  score -= boilerplateHits * 30;
  if (words < 5 || words > 320) score -= 28;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function rankCandidates(candidates, minimumWords = 12) {
  return candidates
    .filter((candidate) => {
      const words = countWords(candidate.remark);
      return words >= minimumWords && words <= 220;
    })
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.wordCount - a.wordCount || b.id - a.id);
}

export function buildObservationUrl(observationId, identificationId) {
  if (!observationId) return "https://www.inaturalist.org";
  const anchor = identificationId ? `#identification-${identificationId}` : "";
  return `https://www.inaturalist.org/observations/${observationId}${anchor}`;
}

export function normalizeCandidate(record, taxon = {}) {
  const identification = record.identification ?? {};
  const observation = identification.observation ?? {};
  const identifier = identification.user ?? {};
  const photos = observation.photos ?? [];
  const remark = cleanRemark(identification.body);

  return {
    id: record.id,
    exemplarIdentificationId: record.id,
    identificationId: identification.id,
    observationId: observation.id,
    taxonId: identification.taxon?.id,
    remark,
    wordCount: countWords(remark),
    language: detectLanguage(remark),
    createdAt: identification.created_at,
    identifier,
    taxon,
    photos,
    photoCount: photos.length,
    observationUrl: buildObservationUrl(observation.id, identification.id),
    tags: classifyRemark(remark),
    votes: record.cached_votes_total ?? 0,
    source: "exemplar",
  };
}

export function normalizeObservationCandidates(observation) {
  const photos = observation.photos ?? [];
  const owner = observation.user ?? {};

  return (observation.identifications ?? [])
    .filter((identification) => (
      identification.body
      && identification.current !== false
      && !identification.hidden
      && !identification.spam
    ))
    .map((identification) => {
      const remark = cleanRemark(identification.body);
      return {
        id: `identification-${identification.id}`,
        exemplarIdentificationId: "",
        identificationId: identification.id,
        observationId: observation.id,
        taxonId: identification.taxon?.id,
        remark,
        wordCount: countWords(remark),
        language: detectLanguage(remark),
        createdAt: identification.created_at,
        identifier: identification.user ?? {},
        taxon: identification.taxon ?? {},
        photos,
        photoCount: photos.length,
        observationUrl: buildObservationUrl(observation.id, identification.id),
        observationOwner: owner.login ?? "",
        tags: ["owner observation", ...classifyRemark(remark)].slice(0, 3),
        votes: 0,
        source: "owned_observation",
      };
    });
}

// Records from /v1/identifications: the record IS the identification, with the
// observation (and its photos/owner) nested inside. Returns [] for IDs without
// a usable remark so it can be used with flatMap.
export function normalizeIdentificationCandidates(identification) {
  if (
    !identification.body
    || identification.current === false
    || identification.hidden
    || identification.spam
  ) {
    return [];
  }

  const observation = identification.observation ?? {};
  const photos = observation.photos ?? [];
  const remark = cleanRemark(identification.body);

  return [{
    id: `identification-${identification.id}`,
    exemplarIdentificationId: "",
    identificationId: identification.id,
    observationId: observation.id,
    taxonId: identification.taxon?.id,
    remark,
    wordCount: countWords(remark),
    language: detectLanguage(remark),
    createdAt: identification.created_at,
    identifier: identification.user ?? {},
    taxon: identification.taxon ?? {},
    photos,
    photoCount: photos.length,
    observationUrl: buildObservationUrl(observation.id, identification.id),
    observationOwner: observation.user?.login ?? "",
    tags: ["by this identifier", ...classifyRemark(remark)].slice(0, 3),
    votes: 0,
    source: "identifier",
  }];
}

export const rankingInternals = {
  DIAGNOSTIC_PATTERNS,
  CONTRAST_PATTERNS,
  EVIDENCE_PATTERNS,
  BOILERPLATE_PATTERNS,
};
