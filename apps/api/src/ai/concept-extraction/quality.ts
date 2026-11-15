import { ensure } from "../core/errors.ts";
import { text } from "../core/schema.ts";
import type { Concept } from "../core/contracts.ts";

export function validateDetailedExplanations(concepts: Concept[]): void {
  for (const concept of concepts) for (const detail of concept.details ?? []) validateConceptExplanation(detail.description);
}

// Check prose only: a quoted source or code sample can legitimately contain instructions.
export function validateConceptExplanation(value: unknown): string {
  const description = text.parse(value);
  const prose = description.replace(/```[\s\S]*?```|`[^`\n]+`|^>.*$/gm, " ");
  ensure(!/(?:이|본)\s*(?:단원|레슨|수업|장|절|강의|설명)(?:에서는?|은|는)[^.!?\n]{0,180}?(?:살펴|알아|배|학습|다|설명|이해)[^.!?\n]*(?:겠습니다|봅니다|웁니다|룹니다|합니다)|(?:살펴보겠습니다|알아보겠습니다|배우겠습니다|학습하겠습니다|설명하겠습니다)|\b(?:in this (?:lesson|chapter|section)|we (?:will|are going to) (?:learn|explore|discuss))\b/i.test(prose),
    "Replace lesson announcements with the actual definition, mechanism or example. Do not describe what this lesson will teach.");
  ensure(!/^(?:짧은 요약|생성된 설명|새로운 설명입니다\.?|개념의 의미를 간결하게 설명합니다\.?)\s*$/.test(prose.trim()),
    "The response is a placeholder. Explain the supplied topic using its source facts.");
  const paragraphs = prose.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()).filter(Boolean);
  ensure(new Set(paragraphs).size === paragraphs.length,
    "Remove repeated paragraphs; each paragraph must add a distinct source-supported explanation.");
  const sentences = prose.split(/[.!?。]+/).map((sentence) => sentence.replace(/\s+/g, " ").trim()).filter((sentence) => sentence.length >= 24);
  ensure(new Set(sentences).size === sentences.length,
    "Remove repeated sentences and explain the next supported fact instead.");
  return description;
}
