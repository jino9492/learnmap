export interface ExplanationBlock {
  type: "heading" | "code" | "paragraph";
  text: string;
}

// Keep generated content as text nodes; never treat model output as HTML.
export function explanationBlocks(value: string): ExplanationBlock[] {
  return value
    .split(/(```[\s\S]*?```)/g)
    .filter((part) => part.trim())
    .flatMap<ExplanationBlock>((part) => {
      if (part.startsWith("```"))
        return [
          {
            type: "code",
            text: part
              .replace(/^```[^\n]*\n?/, "")
              .replace(/```$/, "")
              .trimEnd(),
          },
        ];
      return part
        .trim()
        .split(/\n\s*\n/)
        .flatMap<ExplanationBlock>((paragraph) => {
          const lines = paragraph.split("\n");
          const first = lines[0].trim();
          const heading =
            /^#{1,6}\s+/.test(first) ||
            (lines.length > 1 &&
              first.length <= 60 &&
              !/[.!?。:]$/.test(first));
          if (!heading) return [{ type: "paragraph", text: paragraph }];
          const blocks: ExplanationBlock[] = [
            {
              type: "heading",
              text: first
                .replace(/^#{1,6}\s+/, "")
                .replace(/^\*\*(.*?)\*\*$/, "$1"),
            },
          ];
          const remainder = lines.slice(1).join("\n");
          if (remainder.trim())
            blocks.push({ type: "paragraph", text: remainder });
          return blocks;
        });
    });
}
