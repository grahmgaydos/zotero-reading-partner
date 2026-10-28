// Getting ideas out of the conversation and into the library: the pinned
// point, highlights with that point as their comment, and notes.

import { CONVERSATION_NOTE_TITLE, paperTitle } from "./context";
import { getPrefs } from "./prefs";
import type { Message } from "./session";

// --- The pinned point -------------------------------------------------------
// One at a time, shared across windows. Pin something in the chat, then
// select a passage in the PDF to attach it there.

export interface Pin {
  text: string;
  attachmentID: number;
}

let pin: Pin | null = null;
const pinListeners = new Set<() => void>();

export function getPin(): Pin | null {
  return pin;
}

export function setPin(p: Pin | null): void {
  pin = p;
  for (const fn of pinListeners) fn();
}

export function onPinChange(fn: () => void): () => void {
  pinListeners.add(fn);
  return () => pinListeners.delete(fn);
}

// --- Annotations ------------------------------------------------------------

/**
 * Highlights `selection` (the reader's text-selection annotation: text,
 * position, sortIndex, pageLabel) with `comment` as the comment.
 */
export async function addHighlightWithComment(
  attachment: any,
  selection: any,
  comment: string
): Promise<void> {
  // The selection comes from the reader iframe; copy it into our compartment.
  const sel = JSON.parse(JSON.stringify(selection));
  await Zotero.Annotations.saveFromJSON(attachment, {
    key: Zotero.DataObjectUtilities.generateKey(),
    type: "highlight",
    text: sel.text,
    position: sel.position,
    sortIndex: sel.sortIndex,
    pageLabel: sel.pageLabel ?? "",
    color: getPrefs().highlightColor,
    comment,
    tags: [],
  });
}

export async function appendToAnnotationComment(annotation: any, text: string): Promise<void> {
  const existing = (annotation.annotationComment || "").trim();
  annotation.annotationComment = existing ? `${existing}\n\n${text}` : text;
  await annotation.saveTx();
}

// --- Notes ------------------------------------------------------------------

function esc(s: string): string {
  return Zotero.Utilities.htmlSpecialChars(s);
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

async function saveNote(attachment: any, html: string): Promise<void> {
  const note = new Zotero.Item("note");
  note.libraryID = attachment.libraryID;
  const parent = attachment.parentItem;
  if (parent) note.parentID = parent.id;
  note.setNote(html);
  await note.saveTx();
}

export async function saveTextAsNote(attachment: any, text: string): Promise<void> {
  await saveNote(attachment, `<div>${paragraphs(text)}</div>`);
}

export async function saveConversationAsNote(attachment: any, messages: Message[]): Promise<void> {
  const body = messages
    .filter((m) => m.content && !m.error)
    .map((m) => {
      const who = m.role === "user" ? "Me" : "Reading Partner";
      const focus = m.focus
        ? `<blockquote>${esc(m.focus.text)}${m.focus.pageLabel ? ` (p. ${esc(m.focus.pageLabel)})` : ""}</blockquote>`
        : "";
      return `<h3>${who}</h3>${focus}${paragraphs(m.content)}`;
    })
    .join("");
  const title = `${CONVERSATION_NOTE_TITLE}: ${esc(paperTitle(attachment))}`;
  await saveNote(attachment, `<div><h1>${title}</h1>${body}</div>`);
}
