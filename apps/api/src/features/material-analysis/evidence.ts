import type { Material } from "../../ai/core/contracts.ts";

export function evidenceCatalog(material: Material) {
  const quotes = new Map<string, { sourceLocation: string; text: string }>();
  const sources = material.sources.map((source) => {
    const excerpts: { id: string; text: string }[] = [];
    for (let start = 0; start < source.text.length;) {
      let end = Math.min(start + 400, source.text.length);
      if (end < source.text.length) {
        const boundary = Math.max(source.text.lastIndexOf("\n", end), source.text.lastIndexOf(" ", end));
        if (boundary > start + 200) end = boundary + 1;
      }
      const text = source.text.slice(start, end);
      start = end;
      if (!text.trim()) continue;
      const id = `q${quotes.size + 1}`;
      excerpts.push({ id, text });
      quotes.set(id, { sourceLocation: source.location, text });
    }
    return { location: source.location, excerpts };
  });
  return { data: { id: material.id, title: material.title, sources }, quotes };
}

