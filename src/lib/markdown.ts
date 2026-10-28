// Just enough Markdown for chat replies: paragraphs, bullet and numbered
// lists, block quotes, **bold**, *italic* and `code`. Underscore
// emphasis is left out so snake_case survives. Builds DOM nodes
// directly, so model output is never parsed as HTML.

const HTML_NS = "http://www.w3.org/1999/xhtml";

export function renderMarkdown(doc: Document, src: string): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const el = (tag: string) => doc.createElementNS(HTML_NS, tag) as HTMLElement;

  for (const block of src.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;

    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      const ul = el("ul");
      for (const l of lines) ul.append(inline(doc, el("li"), l.replace(/^\s*[-*•]\s+/, "")));
      frag.append(ul);
    } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      const ol = el("ol");
      for (const l of lines) ol.append(inline(doc, el("li"), l.replace(/^\s*\d+[.)]\s+/, "")));
      frag.append(ol);
    } else if (lines.every((l) => /^\s*>/.test(l))) {
      const bq = el("blockquote");
      inline(doc, bq, lines.map((l) => l.replace(/^\s*>\s?/, "")).join("\n"));
      frag.append(bq);
    } else {
      // Headings are rendered as bold paragraphs; the pane is too narrow for more.
      const text = lines.join("\n").replace(/^#{1,6}\s+(.*)$/gm, "**$1**");
      frag.append(inline(doc, el("p"), text));
    }
  }
  return frag;
}

function inline(doc: Document, parent: HTMLElement, text: string): HTMLElement {
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\n)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok === "\n") {
      parent.append(doc.createElementNS(HTML_NS, "br"));
    } else {
      const tag = tok.startsWith("**") ? "strong" : tok.startsWith("`") ? "code" : "em";
      const strip = tag === "strong" ? 2 : 1;
      const node = doc.createElementNS(HTML_NS, tag);
      node.textContent = tok.slice(strip, -strip);
      parent.append(node);
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
  return parent;
}
