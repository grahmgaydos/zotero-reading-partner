// Hooks into the PDF reader itself: the popup over selected text, the
// right-click menu on the page, and the right-click menu on annotations.

import { getSession, type Focus } from "./session";
import { revealPane } from "./pane";
import { addHighlightWithComment, appendToAnnotationComment, getPin, setPin } from "./writeback";

type Handler = (event: any) => void;
const handlers: [string, Handler][] = [];

export function registerReaderHooks(pluginID: string): void {
  on(pluginID, "renderTextSelectionPopup", ({ reader, doc, params, append }) => {
    const selection = params.annotation;
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 2px;";
    row.append(
      popupButton(doc, "Discuss", () => discuss(reader, selectionFocus(selection)))
    );
    if (getPin()) {
      row.append(
        popupButton(doc, "Add pinned point as comment", () => attachPin(reader, selection))
      );
    }
    append(row);
  });

  // The page's right-click menu doesn't receive the selection, so read it
  // from the reader's own selection-popup state. That's internal to the
  // reader; if it moves, these items just don't appear and the popup
  // buttons above still work.
  on(pluginID, "createViewContextMenu", ({ reader, append }) => {
    const selection = currentSelection(reader);
    if (!selection?.text) return;
    append({
      label: "Discuss with Reading Partner",
      onCommand: () => discuss(reader, selectionFocus(selection)),
    });
    if (getPin()) {
      append({
        label: "Add pinned point as comment",
        onCommand: () => attachPin(reader, selection),
      });
    }
  });

  on(pluginID, "createAnnotationContextMenu", ({ reader, params, append }) => {
    if (params.ids.length !== 1) return;
    const annotation = annotationByKey(reader, params.ids[0]);
    if (!annotation) return;
    append({
      label: "Discuss with Reading Partner",
      onCommand: () =>
        discuss(reader, {
          text: annotation.annotationText || "(an image or note annotation)",
          pageLabel: annotation.annotationPageLabel || undefined,
          comment: annotation.annotationComment || undefined,
        }),
    });
    const pin = getPin();
    if (pin) {
      append({
        label: "Append pinned point to comment",
        onCommand: () => {
          appendToAnnotationComment(annotation, pin.text)
            .then(() => {
              getSession(reader.itemID).recordPinnedPoint({
                text: pin.text,
                passage: annotation.annotationText || "",
                pageLabel: annotation.annotationPageLabel || undefined,
              });
              setPin(null);
            })
            .catch((e: any) => log(`append failed: ${e?.message || e}`));
        },
      });
    }
  });
}

export function unregisterReaderHooks(): void {
  for (const [type, handler] of handlers) Zotero.Reader.unregisterEventListener(type, handler);
  handlers.length = 0;
}

function on(pluginID: string, type: string, handler: Handler): void {
  const safe: Handler = (event) => {
    try {
      handler(event);
    } catch (e: any) {
      log(`${type} handler error: ${e?.message || e}`);
    }
  };
  Zotero.Reader.registerEventListener(type, safe, pluginID);
  handlers.push([type, safe]);
}

function popupButton(doc: Document, label: string, onClick: () => void): HTMLElement {
  const b = doc.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "font:inherit;font-size:12px;padding:2px 8px;border-radius:4px;" +
    "border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:default;";
  b.addEventListener("click", onClick);
  return b;
}

function selectionFocus(selection: any): Focus {
  return { text: String(selection.text || "").trim(), pageLabel: selection.pageLabel || undefined };
}

function currentSelection(reader: any): any {
  const state = reader._internalReader?._state;
  return state?.primaryViewSelectionPopup?.annotation ?? state?.secondaryViewSelectionPopup?.annotation;
}

function annotationByKey(reader: any, key: string): any {
  const attachment = Zotero.Items.get(reader.itemID);
  return attachment && Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
}

// Closes the selection popup, as the reader does after its own actions.
// Internal API; if it moves, the popup just stays open.
function clearSelection(reader: any): void {
  try {
    reader._internalReader?._lastView?.clearSelection?.();
  } catch {
    /* ignore */
  }
}

function discuss(reader: any, focus: Focus): void {
  clearSelection(reader);
  getSession(reader.itemID).setDraftFocus(focus);
  revealPane();
}

function attachPin(reader: any, selection: any): void {
  const pin = getPin();
  if (!pin) return;
  const attachment = Zotero.Items.get(reader.itemID);
  clearSelection(reader);
  addHighlightWithComment(attachment, selection, pin.text)
    .then(() => {
      getSession(reader.itemID).recordPinnedPoint({
        text: pin.text,
        passage: String(selection.text || ""),
        pageLabel: selection.pageLabel || undefined,
      });
      setPin(null);
    })
    .catch((e: any) => log(`highlight failed: ${e?.message || e}`));
}

function log(msg: string): void {
  Zotero.debug(`[Reading Partner] ${msg}`);
}
