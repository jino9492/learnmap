import type { Concept, Material, Relation } from "../core/contracts.ts";
import { relationEvidence } from "./evidence.ts";

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
}

// This recognizes explicit taxonomic statements, not inferred relationships or generated summaries.
export function explicitHierarchyDirection(material: Material, left: Concept, right: Concept): Pick<Relation, "source" | "target"> | undefined {
  const passages = [...relationEvidence(left, material), ...relationEvidence(right, material)].map((citation) => citation.evidence);
  return hierarchyDirectionFromText(passages, left, right);
}

export function hierarchyDirectionFromText(passages: string[], left: Concept, right: Concept): Pick<Relation, "source" | "target"> | undefined {
  if (left.name === right.name) return;
  function statedSubtype(child: Concept, parent: Concept): boolean {
    const childName = escapePattern(child.name);
    const parentName = escapePattern(parent.name);
    const pattern = new RegExp(`${childName}(?:\\s*\\([^)]{0,80}\\))?\\s*(?:은|는|이|가)\\s+[^.!?。]{0,100}?${parentName}\\s*의\\s*(?:한\\s*)?(?:분야|형태|종류|하위\\s*개념|부분\\s*집합)(?:로(?:서|써)?|으로|라고|라는|이|입|에|이다|입니다|[.\\s]|$)|${childName}\\s+is\\s+(?:a\\s+)?(?:kind|type|form|subset)\\s+of\\s+${parentName}(?:[.\\s]|$)`, "i");
    return passages.some((passage) => passage.split(/[.!?。]/).some((sentence) => pattern.test(sentence)
      && !/아니|않|없|가정|오개념|잘못|틀린|거짓|다르|(?:주장|설명|생각|표현|분류).{0,12}(?:틀|오류)|\b(?:not|never|incorrect|false|suppose)\b/i.test(sentence)));
  }
  const leftIsChild = statedSubtype(left, right);
  const rightIsChild = statedSubtype(right, left);
  if (leftIsChild === rightIsChild) return;
  return leftIsChild ? { source: right.id, target: left.id } : { source: left.id, target: right.id };
}
