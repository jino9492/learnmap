// Keep generated content as text nodes; never treat model output as HTML.
export function explanationBlocks(value) {
  return value.split(/(```[\s\S]*?```)/g).filter((part) => part.trim()).flatMap((part) => {
    if (part.startsWith('```')) return [{ type: 'code', text: part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trimEnd() }];
    return part.trim().split(/\n\s*\n/).flatMap((paragraph) => {
      const lines = paragraph.split('\n');
      const first = lines[0].trim();
      const heading = /^#{1,6}\s+/.test(first) || (lines.length > 1 && first.length <= 60 && !/[.!?。:]$/.test(first));
      if (!heading) return [{ type: 'paragraph', text: paragraph }];
      return [{ type: 'heading', text: first.replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1') },
        ...(lines.slice(1).join('\n').trim() ? [{ type: 'paragraph', text: lines.slice(1).join('\n') }] : [])];
    });
  });
}
