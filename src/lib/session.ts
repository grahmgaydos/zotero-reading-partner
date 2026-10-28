// One conversation per PDF attachment. Holds the messages, the cached paper
// text and reader context, and the in-flight request. Conversations are saved
// to <Zotero data dir>/reading-partner/ so closing a tab doesn't lose them.

import { streamChat, type ChatTurn, type Usage } from "./backends";
import { buildPaper, buildReaderContext, buildRelated, type ReaderContext } from "./context";
import { getPrefs } from "./prefs";

export interface Focus {
  text: string;
  pageLabel?: string;
  comment?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  focus?: Focus;
  /** The page label the reader was on when this was sent. */
  page?: string;
  usage?: Usage;
  error?: string;
}

/** A chat point the reader attached to a passage as a highlight comment. */
export interface PinnedPoint {
  text: string;
  passage: string;
  pageLabel?: string;
}

type Listener = () => void;

const sessions = new Map<number, Session>();

export function getSession(attachmentID: number): Session {
  let s = sessions.get(attachmentID);
  if (!s) {
    s = new Session(attachmentID);
    sessions.set(attachmentID, s);
  }
  return s;
}

export function allSessions(): Session[] {
  return [...sessions.values()];
}

export function stopAll(): void {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}

export class Session {
  messages: Message[] = [];
  busy = false;
  /** Shown in the pane's status line; set while loading context or on failure. */
  status = "";
  context: ReaderContext | null = null;
  /** A passage queued from the reader ("Discuss"), attached to the next message. */
  draftFocus: Focus | null = null;
  /** Attachment IDs of other readings brought in for comparison. */
  related: number[] = [];
  pinnedPoints: PinnedPoint[] = [];
  /** How many messages have already gone into a wiki entry. */
  exportedThrough = 0;

  // Read once per conversation and never rebuilt, so every later turn can
  // reuse the cached prefix.
  private paper: string | null = null;
  private relatedText: string | null = null;
  private contextDirty = true;
  private abort: AbortController | null = null;
  private listeners = new Set<Listener>();
  private loaded: Promise<void>;

  constructor(readonly attachmentID: number) {
    this.loaded = this.load();
  }

  get attachment(): any {
    return Zotero.Items.get(this.attachmentID);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e: any) {
        log(`listener error: ${e?.message || e}`);
      }
    }
  }

  setRelated(ids: number[]): void {
    this.related = ids;
    this.relatedText = null;
    this.emit();
    void this.save();
  }

  recordPinnedPoint(p: PinnedPoint): void {
    this.pinnedPoints.push(p);
    void this.save();
  }

  markExported(): void {
    this.exportedThrough = this.messages.length;
    this.pinnedPoints = [];
    void this.save();
  }

  setDraftFocus(focus: Focus | null): void {
    this.draftFocus = focus;
    this.emit();
  }

  /** Called by the notifier when this paper's annotations or notes change. */
  markContextDirty(): void {
    this.contextDirty = true;
    // Refresh the counts shown in the pane, without waiting for the next send.
    if (!this.busy) void this.refreshContext().then(() => this.emit());
  }

  async refreshContext(): Promise<ReaderContext> {
    if (!this.context || this.contextDirty) {
      this.contextDirty = false;
      this.context = await buildReaderContext(this.attachment, getPrefs());
    }
    return this.context;
  }

  async send(text: string, focus?: Focus, page?: string): Promise<void> {
    await this.loaded;
    if (this.busy || !text.trim()) return;
    const prefs = getPrefs();
    this.messages.push({ role: "user", content: text.trim(), focus, page });
    const reply: Message = { role: "assistant", content: "" };
    this.messages.push(reply);
    this.busy = true;
    this.emit();

    try {
      this.abort = new AbortController();
      if (this.paper === null) {
        this.status = "Reading the paper…";
        this.emit();
        const pageNum = Number.parseInt(page ?? "", 10);
        this.paper = (await buildPaper(this.attachment, prefs, pageNum || undefined)).text;
      }
      if (this.relatedText === null && this.related.length) {
        this.status = "Reading the other texts…";
        this.emit();
      }
      this.relatedText ??= await buildRelated(this.related, prefs);
      const ctx = await this.refreshContext();
      this.status = "";
      this.emit();

      let pending = false;
      reply.usage = await streamChat(
        prefs,
        {
          system: prefs.prompt,
          paper: this.paper,
          related: this.relatedText,
          readerContext: ctx.text,
          turns: this.turns(),
        },
        (delta) => {
          reply.content += delta;
          // Coalesce re-renders to one per tick while tokens stream in.
          if (!pending) {
            pending = true;
            Promise.resolve().then(() => {
              pending = false;
              this.emit();
            });
          }
        },
        this.abort?.signal
      );
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        reply.error = e?.message || String(e);
        log(`send failed: ${reply.error}`);
      }
      this.status = "";
    } finally {
      this.busy = false;
      this.abort = null;
      this.emit();
      void this.save();
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  async clear(): Promise<void> {
    this.stop();
    this.messages = [];
    this.exportedThrough = 0;
    this.pinnedPoints = [];
    this.emit();
    await this.save();
  }

  // The model sees the selected passage inline with the question. Failed and
  // empty replies are dropped, along with the question that produced them,
  // so roles keep alternating.
  private turns(): ChatTurn[] {
    const out: ChatTurn[] = [];
    let lastPage: string | undefined;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "user") {
        const next = this.messages[i + 1];
        const isLast = i === this.messages.length - 2;
        if (!isLast && (!next || next.error || !next.content)) continue;
        out.push({ role: "user", content: userTurn(m, lastPage) });
        lastPage = m.page ?? lastPage;
      } else if (!m.error && m.content) {
        out.push({ role: "assistant", content: m.content });
      }
    }
    return out;
  }

  private filePath(): string {
    const a = this.attachment;
    return PathUtils.join(Zotero.DataDirectory.dir, "reading-partner", `${a.libraryID}-${a.key}.json`);
  }

  private async load(): Promise<void> {
    try {
      const path = this.filePath();
      if (await IOUtils.exists(path)) {
        const data = JSON.parse(await IOUtils.readUTF8(path));
        if (Array.isArray(data?.messages)) this.messages = data.messages;
        if (Array.isArray(data?.related)) this.related = data.related;
        if (Array.isArray(data?.pinnedPoints)) this.pinnedPoints = data.pinnedPoints;
        this.exportedThrough = Number(data?.exportedThrough) || 0;
        this.emit();
      }
    } catch (e: any) {
      log(`load failed: ${e?.message || e}`);
    }
  }

  private async save(): Promise<void> {
    try {
      const path = this.filePath();
      await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
      await IOUtils.writeUTF8(path, JSON.stringify({
          version: 1,
          messages: this.messages,
          related: this.related,
          pinnedPoints: this.pinnedPoints,
          exportedThrough: this.exportedThrough,
        }));
    } catch (e: any) {
      log(`save failed: ${e?.message || e}`);
    }
  }
}

// What the model sees for a user message: where they are now (only when it
// has changed since their last message, e.g. after reading on from p. 6 to
// p. 14), the passage they picked, then what they wrote.
function userTurn(m: Message, lastPage: string | undefined): string {
  const parts: string[] = [];
  if (m.page && m.page !== lastPage) {
    parts.push(lastPage ? `(I've moved on from p. ${lastPage} and I'm now on p. ${m.page}.)` : `(I'm on p. ${m.page}.)`);
  }
  if (m.focus) {
    const where = m.focus.pageLabel ? ` (p. ${m.focus.pageLabel})` : "";
    let quote = `I'm looking at this passage${where}:\n> ${m.focus.text.replace(/\n/g, "\n> ")}`;
    if (m.focus.comment) quote += `\nMy comment on it: ${m.focus.comment}`;
    parts.push(quote);
  }
  parts.push(m.content);
  return parts.join("\n\n");
}

function log(msg: string): void {
  Zotero.debug(`[Reading Partner] ${msg}`);
}
