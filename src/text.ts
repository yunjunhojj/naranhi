export type Sentence = {
  key: string;
  text: string;
};

export type Language = "en" | "ko";

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function splitSentences(source: string, language: Language): Sentence[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  const occurrences = new Map<string, number>();

  return Array.from(segmenter.segment(trimmed))
    .map(({ segment }) => segment.trim())
    .filter(Boolean)
    .map((text) => {
      const hash = hashText(text);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      return { key: `${hash}-${occurrence}`, text };
    });
}

export function countWords(source: string): number {
  return source.trim() ? source.trim().split(/\s+/).length : 0;
}
