// Plugin entry point. Bootstrap.js loads our bundled output as a sub-script
// and calls ReadingPartner.startup() / ReadingPartner.shutdown().

import { getPrefs } from "./lib/prefs";
import { testConnection } from "./lib/backends";
import { registerPane } from "./lib/pane";
import { registerReaderHooks, unregisterReaderHooks } from "./lib/reader";
import { allSessions, stopAll } from "./lib/session";
import { DEFAULT_PROMPT } from "./lib/prompt";

// The bootstrap sandbox lacks some web globals that the streaming code
// needs (AbortController, at least, in Zotero 11). Import any that are
// missing, falling back to the main window's.
for (const name of ["fetch", "AbortController", "TextDecoder", "URL"]) {
  if (name in globalThis) continue;
  try {
    Components.utils.importGlobalProperties([name]);
  } catch {
    /* not importable here */
  }
  if (!(name in globalThis)) (globalThis as any)[name] = Zotero.getMainWindow()?.[name];
  Zotero.debug(`[Reading Partner] imported global ${name}: ${typeof (globalThis as any)[name]}`);
}

try {
  Zotero.debug("[Reading Partner] bundle evaluated");
} catch {
  /* Zotero global missing — log infrastructure broken */
}

const PREFS_PANE_ID = "zotero-prefpane-reading-partner";
const FTL = "reading-partner.ftl";

let notifierID: string | null = null;

export const ReadingPartner = {
  async startup(data: BootstrapData) {
    try {
      await Zotero.PreferencePanes.register({
        pluginID: data.id,
        src: `${data.rootURI}content/prefs.xhtml`,
        id: PREFS_PANE_ID,
        label: "Reading Partner",
        scripts: [`${data.rootURI}content/prefs-page.js`],
      });
    } catch (e: any) {
      Zotero.debug(`[Reading Partner] prefs pane register error: ${e?.message || e}`);
    }

    // For the prefs pane's Test connection button and prompt placeholder.
    (Zotero as any).ReadingPartner = {
      testConnection: async () => testConnection(getPrefs()),
      defaultPrompt: DEFAULT_PROMPT,
    };

    for (const win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
    registerPane(data.id);
    registerReaderHooks(data.id);
    registerNotifier();
  },

  onMainWindowLoad(win: any) {
    win.MozXULElement.insertFTLIfNeeded(FTL);
  },

  onMainWindowUnload(win: any) {
    win.document.querySelector(`[href="${FTL}"]`)?.remove();
  },

  async shutdown() {
    if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
    unregisterReaderHooks();
    stopAll();
    for (const win of Zotero.getMainWindows()) this.onMainWindowUnload(win);
    delete (Zotero as any).ReadingPartner;
  },
};

// Highlights and notes go back into context on the next message. Item events
// don't say which paper a deleted item belonged to, so deletions mark every
// open conversation; rebuilding the context is cheap.
function registerNotifier(): void {
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, _type: string, ids: number[]) => {
        const sessions = allSessions();
        if (!sessions.length) return;
        if (event === "delete" || event === "trash") {
          for (const s of sessions) s.markContextDirty();
          return;
        }
        const items = (Zotero.Items.get(ids) as any[]).filter(Boolean);
        for (const s of sessions) {
          const parentID = s.attachment?.parentID;
          const touched = items.some(
            (i) =>
              (i.isAnnotation?.() && i.parentID === s.attachmentID) ||
              (i.isNote?.() && parentID && i.parentID === parentID)
          );
          if (touched) s.markContextDirty();
        }
      },
    },
    ["item"],
    "reading-partner"
  );
}

(globalThis as any).ReadingPartner = ReadingPartner;
