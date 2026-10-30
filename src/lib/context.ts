// Builds what the model sees about the open paper: the text itself (once per
// conversation) and the reader's own highlights, comments and notes (rebuilt
// whenever they change).

import type { Prefs } from "./prefs";
import { getPdfText, trimForModel } from "./pdf";

// Child notes whose heading starts with this are whole exported
// conversations. They would only feed the model its own words back, so they
// stay out of context. Matched on the heading text because Zotero's note
// editor drops custom attributes when a note is edited.
export const CONVERSATION_NOTE_TITLE = "Reading Partner conversation";

const MAX_NOTES_CHARS = 20000;

const COLOR_NAMES: Record<string, string> = {
  "#ffd400": "yellow",
  "#ff6666": "red",
  "#5fb236": "green",
  "#2ea8e5": "blue",
  "#a28ae5": "purple",
  "#e56eee": "magenta",
  "#f19837": "orange",
  "#aaaaaa": "grey",
};

export function paperTitle(attachment: any): string {
  const parent = attachment.parentItem;
  return (parent ?? attachment).getDisplayTitle?.() || (parent ?? attachment).getField("title") || "Untitled";
}

export function citation(attachment: any): string {
  const item = attachment.parentItem ?? attachment;
  const creators = (item.getCreators?.() ?? []) as any[];
  const names = creators.map((c) => c.lastName || c.name).filter(Boolean);
  const authors =
    names.length > 2 ? `${names[0]} et al.` : names.length ? names.join(" and ") : "";
  const year = String(item.getField?.("date") ?? "").match(/\d{4}/)?.[0] ?? "";
  return [authors, year].filter(Boolean).join(", ");
}

export interface PagedText {
  text: string;
  /** Page numbers included, or null when the whole text fitted. */
  kept: Set<number> | null;
}

// Zotero's extracted text separates pages with form feeds. Marking them lets
// the model cite real page numbers instead of guessing.
//
// By default the whole paper goes in. Only if a cap is set and the paper is
// over it does this keep the opening (a fifth of the
// budget), the end (a tenth) and the rest as a window around the page being
// read, so a conversation about p. 26 of a 41-page report has p. 26 in front
// of it. Text without page breaks falls back to opening plus end.
async function pagedText(attachment: any, maxChars: number, focusPage = 1): Promise<PagedText> {
  const raw = await getPdfText(attachment, Number.MAX_SAFE_INTEGER, 0);
  const pages = raw.split("\f").map((p, i) => `[p. ${i + 1}]\n${p.trim()}`);
  if (pages.length < 2) return { text: trimForModel(raw, maxChars), kept: null };
  const whole = pages.join("\n\n");
  if (whole.length <= maxChars) return { text: whole, kept: null };

  const kept = new Set<number>();
  let used = 0;
  const take = (i: number, budget: number): boolean => {
    if (i < 0 || i >= pages.length || kept.has(i)) return true;
    if (used + pages[i].length > budget) return false;
    kept.add(i);
    used += pages[i].length;
    return true;
  };
  for (let i = 0; take(i, maxChars * 0.2) && i < pages.length; i++);
  for (let i = pages.length - 1; take(i, maxChars * 0.3) && i >= 0; i--);
  const focus = Math.min(Math.max(focusPage - 1, 0), pages.length - 1);
  // Grow the window outwards from the reader's page, one page each side at
  // a time; a side stops at the first page that doesn't fit, so the window
  // stays contiguous.
  let right = true;
  let left = true;
  for (let d = 0; (right || left) && d < pages.length; d++) {
    if (right) right = focus + d < pages.length && take(focus + d, maxChars);
    if (left) left = focus - d - 1 >= 0 && take(focus - d - 1, maxChars);
  }

  const parts: string[] = [];
  let gapFrom = -1;
  for (let i = 0; i < pages.length; i++) {
    if (kept.has(i)) {
      if (gapFrom !== -1) parts.push(`[… pp. ${gapFrom + 1}–${i} omitted …]`);
      gapFrom = -1;
      parts.push(pages[i]);
    } else if (gapFrom === -1) {
      gapFrom = i;
    }
  }
  if (gapFrom !== -1) parts.push(`[… pp. ${gapFrom + 1}–${pages.length} omitted …]`);
  return { text: parts.join("\n\n"), kept: new Set([...kept].map((i) => i + 1)) };
}

// `where` is the page the reader is on: its position in the PDF (what the
// [p. N] markers count, and what a capped paper is centred on) and its printed
// label. A journal article printed as pp. 215–240 is PDF pp. 1–26; the reader,
// their highlights and the model's citations should use the printed numbers,
// so when the label is a number the model is told the offset.
export async function buildPaper(
  attachment: any,
  prefs: Prefs,
  where: { label?: string; index?: number } = {}
): Promise<PagedText> {
  const cap = prefs.maxChars > 0 ? prefs.maxChars : Number.MAX_SAFE_INTEGER;
  const paged = await pagedText(attachment, cap, where.index);
  const cite = citation(attachment);
  const what = paged.kept
    ? `Its text follows, shortened to fit: some pages are omitted, as marked. [p. N] marks the start of PDF page N.`
    : `Its full text follows; [p. N] marks the start of PDF page N.`;
  const printed = /^\d+$/.test(where.label ?? "") ? Number(where.label) : NaN;
  const offset = where.index && Number.isFinite(printed) ? printed - where.index : 0;
  const numbering = offset
    ? ` The printed page numbers differ: printed page = PDF page ${offset > 0 ? "+" : "−"} ${Math.abs(offset)}` +
      ` (so [p. ${where.index}] is printed p. ${printed}). The reader's page numbers and highlights use printed numbers;` +
      ` give printed numbers when you cite.`
    : "";
  return {
    kept: paged.kept,
    text: `The paper you are discussing is "${paperTitle(attachment)}"${cite ? ` (${cite})` : ""}. ${what}${numbering}\n\n${paged.text}`,
  };
}

export interface ReaderContext {
  text: string;
  annotationCount: number;
  noteCount: number;
}

export async function buildReaderContext(attachment: any, prefs: Prefs): Promise<ReaderContext> {
  const annLines = annotationLines(attachment);
  const noteTexts: string[] = [];
  const parent = attachment.parentItem;
  if (prefs.includeNotes && parent) {
    const notes = Zotero.Items.get(parent.getNotes()) as any[];
    let budget = MAX_NOTES_CHARS;
    for (const n of notes) {
      const html: string = n.getNote() || "";
      const plain = htmlToText(html).slice(0, budget);
      if (plain.startsWith(CONVERSATION_NOTE_TITLE)) continue;
      if (!plain) continue;
      noteTexts.push(plain);
      budget -= plain.length;
      if (budget <= 0) break;
    }
  }

  const parts: string[] = [];
  if (annLines.length) {
    parts.push(
      `The reader's highlights and annotations so far, in reading order ` +
        `(colours are their own categories):\n${annLines.join("\n")}`
    );
  }
  if (noteTexts.length) {
    parts.push(`The reader's notes on this paper:\n\n${noteTexts.join("\n\n---\n\n")}`);
  }
  return {
    text: parts.join("\n\n"),
    annotationCount: annLines.length,
    noteCount: noteTexts.length,
  };
}

function annotationLines(attachment: any): string[] {
  const annotations = (attachment.getAnnotations?.() ?? []) as any[];
  annotations.sort((a, b) =>
    String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex))
  );
  const lines: string[] = [];
  for (const a of annotations) {
    const text = (a.annotationText || "").trim();
    const comment = (a.annotationComment || "").trim();
    if (!text && !comment) continue;
    const tags = [
      a.annotationPageLabel ? `p. ${a.annotationPageLabel}` : "",
      COLOR_NAMES[String(a.annotationColor).toLowerCase()] ?? "",
      a.annotationType !== "highlight" ? a.annotationType : "",
    ].filter(Boolean);
    let line = `- [${tags.join(" · ")}]`;
    if (text) line += ` "${text}"`;
    if (comment) line += ` — their comment: ${comment}`;
    lines.push(line);
  }
  return lines;
}

// --- Other readings ---------------------------------------------------------
// Papers the reader brings in to set against this one, e.g. the paper it
// responds to. Offered from the same collections and from Zotero's
// "Related" items.

export interface Candidate {
  attachmentID: number;
  label: string;
  group: string;
}

export async function relatedCandidates(attachment: any): Promise<Candidate[]> {
  const parent = attachment.parentItem;
  if (!parent) return [];
  const seen = new Set<number>([parent.id]);
  const out: Candidate[] = [];

  const add = async (item: any, group: string) => {
    if (!item?.isRegularItem?.() || seen.has(item.id)) return;
    seen.add(item.id);
    const att = await item.getBestAttachment();
    if (!att) return;
    const cite = citation(att);
    out.push({ attachmentID: att.id, label: `${cite ? cite + " — " : ""}${paperTitle(att)}`, group });
  };

  for (const key of parent.relatedItems ?? []) {
    await add(Zotero.Items.getByLibraryAndKey(parent.libraryID, key), "Related in Zotero");
  }
  for (const id of parent.getCollections()) {
    const coll = Zotero.Collections.get(id);
    if (!coll) continue;
    for (const item of coll.getChildItems(false, false)) await add(item, coll.name);
  }
  return out;
}

export async function buildRelated(ids: number[], prefs: Prefs): Promise<string> {
  const parts: string[] = [];
  for (const id of ids) {
    const att = Zotero.Items.get(id);
    if (!att) continue;
    let text: string;
    try {
      text = (await pagedText(att, prefs.relatedMaxChars)).text;
    } catch (e: any) {
      text = `(Text unavailable: ${e?.message || e})`;
    }
    const cite = citation(att);
    const notes = annotationLines(att);
    parts.push(
      `=== "${paperTitle(att)}"${cite ? ` (${cite})` : ""} ===\n\n${text}` +
        (notes.length ? `\n\nThe reader's highlights on this one:\n${notes.join("\n")}` : "")
    );
  }
  if (!parts.length) return "";
  return (
    `The reader has brought in ${parts.length === 1 ? "another reading" : `${parts.length} other readings`} ` +
    `to set against the paper under discussion, usually because one responds to or disagrees with the other. ` +
    `They are secondary: the paper above is the one being read.\n\n${parts.join("\n\n")}`
  );
}

function htmlToText(html: string): string {
  try {
    return String(Zotero.Utilities.unescapeHTML(html)).trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
