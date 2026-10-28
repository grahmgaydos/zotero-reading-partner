// The chat itself: an item pane section that appears in the reader's
// right-hand pane, with its own icon in the side nav.

import { getSession, type Message, type Session } from "./session";
import {
  getPin,
  onPinChange,
  saveConversationAsNote,
  saveTextAsNote,
  setPin,
} from "./writeback";
import { renderMarkdown } from "./markdown";
import { relatedCandidates } from "./context";
import { draftWikiEntry, writeWikiEntry } from "./wiki";
import { getPrefs } from "./prefs";

export const PANE_ID = "reading-partner";
const HTML_NS = "http://www.w3.org/1999/xhtml";

interface Bound {
  session: Session;
  unsubscribe: () => void;
}
const bound = new WeakMap<Element, Bound>();

export function registerPane(pluginID: string): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID,
    header: { l10nID: "reading-partner-pane-header", icon: "chrome://reading-partner/content/icon.svg" },
    sidenav: { l10nID: "reading-partner-pane-sidenav", icon: "chrome://reading-partner/content/icon.svg" },
    onItemChange: ({ body, tabType, setEnabled }: any) => {
      const reader = tabType === "reader" ? readerForBody(body) : null;
      setEnabled(!!reader);
      return true;
    },
    onRender: ({ body }: any) => {
      const reader = readerForBody(body);
      if (reader) bind(body, getSession(reader.itemID));
    },
    onDestroy: ({ body }: any) => unbind(body),
  });
}

/** Scrolls the reader's side pane to the chat and focuses the input. */
export function revealPane(): void {
  const win = Zotero.getMainWindow();
  for (const details of win.document.querySelectorAll("item-details") as any) {
    const pane = details.getPane?.(PANE_ID);
    if (!pane || !details.getBoundingClientRect().width) continue;
    details.scrollToPane?.(PANE_ID, "smooth");
    pane.querySelector("textarea")?.focus();
    return;
  }
}

function readerForBody(body: Element): any {
  const win = body.ownerDocument.defaultView as any;
  const tabID = win?.Zotero_Tabs?.selectedID;
  return tabID ? Zotero.Reader.getByTabID(tabID) : null;
}

// From the reader's internal view state; undefined if that ever moves.
function currentPageLabel(reader: any): string | undefined {
  const stats = reader?._internalReader?._state?.primaryViewStats;
  return stats?.pageLabel || (stats?.pageIndex !== undefined ? String(stats.pageIndex + 1) : undefined);
}

function unbind(body: Element): void {
  bound.get(body)?.unsubscribe();
  bound.delete(body);
}

function bind(body: Element, session: Session): void {
  const existing = bound.get(body);
  if (existing?.session === session && body.querySelector(".rp")) {
    refresh(body, session);
    return;
  }
  unbind(body);
  build(body, session);
  const offSession = session.subscribe(() => refresh(body, session));
  const offPin = onPinChange(() => refresh(body, session));
  bound.set(body, {
    session,
    unsubscribe: () => {
      offSession();
      offPin();
    },
  });
  refresh(body, session);
  void session.refreshContext().then(() => refresh(body, session));
}

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function build(body: Element, session: Session): void {
  const doc = body.ownerDocument;
  body.replaceChildren();
  const root = h(doc, "div", "rp");
  const style = h(doc, "style");
  style.textContent = CSS;

  const bar = h(doc, "div", "rp-bar");
  const status = h(doc, "span", "rp-status");
  const readingsBtn = h(doc, "button", "rp-btn", "Readings");
  readingsBtn.title = "Bring in other papers from this one's collections to read it against";
  readingsBtn.addEventListener("click", () => void openReadings(panel, session));
  const wikiBtn = h(doc, "button", "rp-btn", "Wiki");
  wikiBtn.title = "Draft an entry for this paper's research-wiki page, to review before filing";
  wikiBtn.addEventListener("click", () => void openWiki(panel, session));
  const newBtn = h(doc, "button", "rp-btn", "New");
  newBtn.title = "Start a new conversation about this paper";
  newBtn.addEventListener("click", () => void session.clear());
  const noteBtn = h(doc, "button", "rp-btn", "Save");
  noteBtn.title = "Save this conversation as a child note";
  noteBtn.addEventListener("click", () => {
    saveConversationAsNote(session.attachment, session.messages)
      .then(() => flash(noteBtn, "Saved"))
      .catch((e: any) => flash(noteBtn, "Failed: " + (e?.message || e)));
  });
  bar.append(status, readingsBtn, wikiBtn, newBtn, noteBtn);

  const panel = h(doc, "div", "rp-panel");
  panel.hidden = true;
  const log = h(doc, "div", "rp-log");
  const pin = h(doc, "div", "rp-pin");
  const focus = h(doc, "div", "rp-focus");

  const compose = h(doc, "div", "rp-compose");
  const input = h(doc, "textarea", "rp-input");
  input.rows = 3;
  input.placeholder = "Think out loud…";
  const send = h(doc, "button", "rp-send", "Send");
  const submit = () => {
    if (session.busy) {
      session.stop();
      return;
    }
    const text = input.value;
    if (!text.trim()) return;
    input.value = "";
    const f = session.draftFocus ?? undefined;
    session.draftFocus = null;
    void session.send(text, f, currentPageLabel(readerForBody(body)));
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  });
  compose.append(input, send);

  root.append(style, bar, panel, log, pin, focus, compose);
  body.append(root);
}

function refresh(body: Element, session: Session): void {
  const doc = body.ownerDocument;
  const q = (s: string) => body.querySelector(s) as HTMLElement | null;
  const log = q(".rp-log");
  if (!log) return;

  const ctx = session.context;
  const status = q(".rp-status")!;
  status.textContent =
    session.status ||
    (ctx
      ? `In context: paper · ${plural(ctx.annotationCount, "highlight")} · ${plural(ctx.noteCount, "note")}`
      : "In context: paper") +
      (session.related.length && !session.status
        ? ` · ${plural(session.related.length, "other reading")}`
        : "");

  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  if (!session.messages.length) {
    log.append(
      h(
        doc,
        "p",
        "rp-empty",
        "Talk the paper through: test a reading, argue with a claim, or select a passage and choose Discuss. Your highlights, comments and notes are already in context."
      )
    );
  }
  session.messages.forEach((m, i) => log.append(renderMessage(doc, session, m, i)));
  if (nearBottom || session.busy) log.scrollTop = log.scrollHeight;

  const pinEl = q(".rp-pin")!;
  const pin = getPin();
  pinEl.replaceChildren();
  pinEl.hidden = !pin;
  if (pin) {
    const label = h(doc, "div", "rp-chip-label", "Pinned. Select a passage, then “Add pinned point as comment”.");
    const text = h(doc, "div", "rp-chip-text", pin.text);
    pinEl.append(label, text, closeButton(doc, () => setPin(null)));
  }

  const focusEl = q(".rp-focus")!;
  const f = session.draftFocus;
  focusEl.replaceChildren();
  focusEl.hidden = !f;
  if (f) {
    const label = h(doc, "div", "rp-chip-label", `Discussing${f.pageLabel ? ` p. ${f.pageLabel}` : ""}`);
    const text = h(doc, "div", "rp-chip-text", f.text);
    focusEl.append(label, text, closeButton(doc, () => session.setDraftFocus(null)));
  }

  const send = q(".rp-send")!;
  send.textContent = session.busy ? "Stop" : "Send";
}

function renderMessage(doc: Document, session: Session, m: Message, index: number): HTMLElement {
  const el = h(doc, "div", `rp-msg rp-${m.role}`);
  if (m.focus) {
    const quote = h(doc, "blockquote", "rp-quote", m.focus.text);
    if (m.focus.pageLabel) quote.append(h(doc, "span", "rp-page", ` p. ${m.focus.pageLabel}`));
    el.append(quote);
  }
  const text = h(doc, "div", "rp-text");
  if (m.role === "assistant") {
    if (m.content) text.append(renderMarkdown(doc, m.content));
    else if (session.busy && index === session.messages.length - 1) text.append(h(doc, "span", "rp-typing", "…"));
  } else {
    text.textContent = m.content;
  }
  el.append(text);
  if (m.error) el.append(h(doc, "div", "rp-error", m.error));

  const done = !(session.busy && index === session.messages.length - 1);
  if (m.role === "assistant" && m.content && done) {
    const actions = h(doc, "div", "rp-actions");
    const pinBtn = h(doc, "button", "rp-link", "Pin");
    pinBtn.title = "Pin this (or the part you've selected) to attach to a passage";
    pinBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
    pinBtn.addEventListener("click", () => pinFrom(session, text, m.content));
    const noteBtn = h(doc, "button", "rp-link", "Save as note");
    noteBtn.addEventListener("mousedown", (e) => e.preventDefault());
    noteBtn.addEventListener("click", () => {
      saveTextAsNote(session.attachment, selectedIn(text) || m.content)
        .then(() => flash(noteBtn, "Saved"))
        .catch((e: any) => flash(noteBtn, "Failed"));
    });
    actions.append(pinBtn, noteBtn);
    if (m.usage?.inputTokens) actions.append(h(doc, "span", "rp-usage", usageLabel(m)));
    el.append(actions);
    el.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      openMenu(doc, e, [
        ["Pin for a passage", () => pinFrom(session, text, m.content)],
        ["Save as note", () => void saveTextAsNote(session.attachment, selectedIn(text) || m.content)],
      ]);
    });
  }
  return el;
}

// --- Other readings ---------------------------------------------------------

async function openReadings(panel: HTMLElement, session: Session): Promise<void> {
  const doc = panel.ownerDocument;
  panel.hidden = false;
  panel.replaceChildren(h(doc, "div", "rp-panel-title", "Read this against…"), h(doc, "p", "rp-hint", "Loading…"));
  let candidates;
  try {
    candidates = await relatedCandidates(session.attachment);
  } catch (e: any) {
    panel.replaceChildren(h(doc, "p", "rp-error", e?.message || String(e)), panelButtons(doc, panel, []));
    return;
  }

  const body: HTMLElement[] = [h(doc, "div", "rp-panel-title", "Read this against…")];
  const boxes: [HTMLInputElement, number][] = [];
  if (!candidates.length) {
    body.push(h(doc, "p", "rp-hint", "Nothing to offer: this paper isn't in a collection with other PDFs, and has no related items."));
  } else {
    const list = h(doc, "div", "rp-choices");
    let group = "";
    for (const c of candidates) {
      if (c.group !== group) {
        group = c.group;
        list.append(h(doc, "div", "rp-group", group));
      }
      const row = h(doc, "label", "rp-choice");
      const box = h(doc, "input");
      box.type = "checkbox";
      box.checked = session.related.includes(c.attachmentID);
      boxes.push([box, c.attachmentID]);
      row.append(box, h(doc, "span", undefined, c.label));
      list.append(row);
    }
    body.push(list);
    const k = Math.round(getPrefs().relatedMaxChars / 4000);
    body.push(
      h(doc, "p", "rp-hint", `For setting the two against each other, not summarising. Each adds up to about ${k}k tokens to every message.`)
    );
  }
  body.push(
    panelButtons(doc, panel, [
      ["Use these", () => session.setRelated(boxes.filter(([b]) => b.checked).map(([, id]) => id))],
    ])
  );
  panel.replaceChildren(...body);
}

// --- Research wiki ----------------------------------------------------------

async function openWiki(panel: HTMLElement, session: Session): Promise<void> {
  const doc = panel.ownerDocument;
  if (session.busy) return;
  panel.hidden = false;
  panel.replaceChildren(h(doc, "div", "rp-panel-title", "Research wiki"), h(doc, "p", "rp-hint", "Drafting an entry from the conversation…"));

  let draft;
  try {
    draft = await draftWikiEntry(session);
  } catch (e: any) {
    panel.replaceChildren(
      h(doc, "div", "rp-panel-title", "Research wiki"),
      h(doc, "p", "rp-error", e?.message || String(e)),
      panelButtons(doc, panel, [])
    );
    return;
  }

  const editor = h(doc, "textarea", "rp-input rp-draft");
  editor.rows = 14;
  editor.value = draft.markdown;
  const where = draft.exists
    ? `Adds this to ${draft.relPath}. Edit it first; nothing is written until you file it.`
    : `${draft.relPath} doesn't exist yet, so this creates it in the PDF Auto-Summariser's format, without a summary. Edit the entry first.`;
  const status = h(doc, "p", "rp-hint", where);
  panel.replaceChildren(
    h(doc, "div", "rp-panel-title", "Research wiki"),
    status,
    editor,
    panelButtons(doc, panel, [
      [
        "File it",
        async () => {
          await writeWikiEntry(session, draft, editor.value);
        },
        `Filed to ${draft.relPath}.`,
      ],
    ])
  );
}

/** Action buttons plus Cancel/Close. An action with a done message shows it before closing. */
function panelButtons(
  doc: Document,
  panel: HTMLElement,
  actions: [string, () => void | Promise<void>, string?][]
): HTMLElement {
  const row = h(doc, "div", "rp-panel-buttons");
  for (const [label, fn, done] of actions) {
    const b = h(doc, "button", "rp-btn rp-primary", label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
        if (done) {
          panel.replaceChildren(h(doc, "p", "rp-hint", done));
          setTimeout(() => (panel.hidden = true), 2500);
        } else {
          panel.hidden = true;
        }
      } catch (e: any) {
        b.disabled = false;
        row.prepend(h(doc, "p", "rp-error", e?.message || String(e)));
      }
    });
    row.append(b);
  }
  const close = h(doc, "button", "rp-btn", actions.length ? "Cancel" : "Close");
  close.addEventListener("click", () => (panel.hidden = true));
  row.append(close);
  return row;
}

function pinFrom(session: Session, textEl: HTMLElement, whole: string): void {
  setPin({ text: selectedIn(textEl) || whole, attachmentID: session.attachmentID });
}

/** The selected text, if the selection lies inside `el`. */
function selectedIn(el: HTMLElement): string {
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return "";
  return sel.toString().trim();
}

// A native XUL context menu, so it looks like the rest of Zotero.
function openMenu(doc: Document, e: MouseEvent, items: [string, () => void][]): void {
  const popup = (doc as any).createXULElement("menupopup");
  for (const [label, fn] of items) {
    const item = (doc as any).createXULElement("menuitem");
    item.setAttribute("label", label);
    item.addEventListener("command", fn);
    popup.append(item);
  }
  popup.addEventListener("popuphidden", () => popup.remove());
  (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(popup);
  popup.openPopupAtScreen(e.screenX, e.screenY, true);
}

function closeButton(doc: Document, onClick: () => void): HTMLElement {
  const b = h(doc, "button", "rp-close", "×");
  b.title = "Clear";
  b.addEventListener("click", onClick);
  return b;
}

function flash(btn: HTMLElement, text: string): void {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1500);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function usageLabel(m: Message): string {
  const u = m.usage!;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  let s = `${k(u.inputTokens!)} in`;
  if (u.cachedTokens) s += ` (${k(u.cachedTokens)} cached)`;
  if (u.outputTokens) s += ` · ${k(u.outputTokens)} out`;
  return s;
}

const CSS = `
.rp { display: flex; flex-direction: column; height: 70vh; min-height: 320px; gap: 6px; font-size: 13px; }
.rp button { font: inherit; color: inherit; }
.rp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.rp-status { flex: 1 0 100%; color: var(--fill-secondary, #666); font-size: 11px; }
.rp-panel { border: 1px solid var(--stroke-secondary, rgba(128,128,128,.4)); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; max-height: 60%; overflow-y: auto; }
.rp-panel[hidden] { display: none; }
.rp-panel-title { font-weight: 600; }
.rp-hint { margin: 0; font-size: 11px; color: var(--fill-secondary, #666); line-height: 1.4; }
.rp-choices { display: flex; flex-direction: column; gap: 3px; }
.rp-group { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--fill-secondary, #666); margin-top: 4px; }
.rp-choice { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; line-height: 1.3; }
.rp-choice input { flex: none; margin: 1px 0 0; }
.rp-draft { font-family: var(--monospace-font, monospace); font-size: 11.5px; }
.rp-panel-buttons { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }
.rp-panel-buttons .rp-error { flex: 1 0 100%; margin: 0; }
.rp-primary { font-weight: 600; }
.rp-btn, .rp-send { padding: 2px 8px; border-radius: 5px; border: 1px solid var(--stroke-secondary, rgba(128,128,128,.4)); background: var(--material-button, transparent); }
.rp-log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; user-select: text; }
.rp-empty { color: var(--fill-secondary, #666); line-height: 1.45; margin: 8px 0; }
.rp-msg { line-height: 1.45; }
.rp-msg p { margin: 0 0 .5em; }
.rp-msg ul, .rp-msg ol { margin: 0 0 .5em; padding-left: 1.3em; }
.rp-user { align-self: flex-end; max-width: 88%; background: var(--fill-quinary, rgba(128,128,128,.12)); border-radius: 8px; padding: 6px 9px; white-space: pre-wrap; }
.rp-assistant { padding: 0 2px; }
.rp-quote { margin: 0 0 4px; padding-left: 8px; border-left: 2px solid var(--accent-blue, #4072e5); color: var(--fill-secondary, #555); font-style: italic; white-space: normal; }
.rp-text blockquote { margin: 0 0 .5em; padding-left: 8px; border-left: 2px solid var(--stroke-secondary, #ccc); }
.rp-page { font-style: normal; font-size: 11px; }
.rp-actions { display: flex; gap: 10px; align-items: baseline; margin-top: 2px; }
.rp-link { border: none; background: none; padding: 0; font-size: 11px; color: var(--accent-blue, #4072e5) !important; }
.rp-usage { margin-left: auto; font-size: 10px; color: var(--fill-tertiary, #999); }
.rp-error { color: var(--accent-red, #d33); font-size: 12px; }
.rp-typing { color: var(--fill-secondary, #666); }
.rp-pin, .rp-focus { position: relative; border-radius: 6px; padding: 5px 24px 5px 8px; font-size: 12px; }
.rp-pin { background: color-mix(in srgb, #a28ae5 18%, transparent); }
.rp-focus { background: color-mix(in srgb, var(--accent-blue, #4072e5) 12%, transparent); }
.rp-chip-label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--fill-secondary, #666); }
.rp-chip-text { max-height: 4.4em; overflow: hidden; }
.rp-close { position: absolute; top: 2px; right: 4px; border: none; background: none; font-size: 14px; }
.rp-compose { display: flex; gap: 6px; align-items: flex-end; }
.rp-input { flex: 1; resize: vertical; font: inherit; padding: 5px 7px; border-radius: 6px; border: 1px solid var(--stroke-secondary, rgba(128,128,128,.4)); background: var(--material-background, transparent); color: inherit; }
`;
