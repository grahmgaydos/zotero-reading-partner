// Research-wiki export: distils a conversation into a dated entry under
// "## Reading conversations" on the paper's source page in the Obsidian vault.
//
// The vault and its source pages belong to the PDF Auto-Summariser (see the
// vault's CLAUDE.md). This file follows its conventions so the two plugins
// can share pages:
//   - pages are found by their `zotero-key` frontmatter, never by filename;
//   - the summariser regenerates only its frontmatter keys and the text
//     between its markers, so our section survives its re-runs;
//   - if there is no page yet, we create one in the same format, with an
//     empty summariser block for it to fill later.
// The metadata and citekey code below is copied from the summariser's
// vault.ts; port fixes across by hand.

import { complete } from "./backends";
import { paperTitle } from "./context";
import { getPrefs, type Prefs } from "./prefs";
import type { Message, Session } from "./session";

const START = "<!-- zotero-summariser:start -->";
const END = "<!-- zotero-summariser:end -->";
const SECTION = "## Reading conversations";
const SUMMARISER_BRANCH = "extensions.pdf-auto-summariser";

export interface VaultTarget {
  vault: string;
  folder: string;
  dir: string;
  /** True when the path came from the PDF Auto-Summariser's settings. */
  shared: boolean;
}

/** Our own vault setting, else the summariser's, else an error saying how to set one. */
export async function vaultTarget(prefs: Prefs): Promise<VaultTarget> {
  let raw = prefs.vaultPath;
  let folderRaw = prefs.vaultSourcesFolder;
  let shared = false;
  if (!raw) {
    raw = String(Zotero.Prefs.get(`${SUMMARISER_BRANCH}.vaultPath`, true) || "").trim();
    folderRaw ||= String(Zotero.Prefs.get(`${SUMMARISER_BRANCH}.vaultSourcesFolder`, true) || "");
    shared = !!raw;
  }
  if (!raw) {
    throw new Error(
      "No research wiki set. Set a vault folder in Settings → Reading Partner, or in the PDF Auto-Summariser's settings."
    );
  }
  const vault = expandHome(raw);
  if (!(await IOUtils.exists(vault))) throw new Error(`Vault folder not found: ${vault}`);
  const folder = folderRaw.trim().replace(/^\/+|\/+$/g, "") || "sources";
  return { vault, folder, dir: PathUtils.join(vault, ...folder.split("/")), shared };
}

export interface WikiDraft {
  /** The full entry, shown for editing before it's written. */
  markdown: string;
  /** Existing page, or where a new one will be created. */
  path: string;
  exists: boolean;
  /** For display, e.g. "sources/KEMPENEER2023.md". */
  relPath: string;
}

export async function draftWikiEntry(session: Session): Promise<WikiDraft> {
  const prefs = getPrefs();
  const target = await vaultTarget(prefs);
  const attachment = session.attachment;
  const parent = attachment.parentItem;
  if (!parent) throw new Error("This PDF isn't attached to a Zotero item, so it has no wiki page.");

  const fresh = session.messages.slice(session.exportedThrough).filter((m) => m.content && !m.error);
  if (!fresh.some((m) => m.role === "assistant")) {
    throw new Error("Nothing new to file since the last wiki entry.");
  }

  const name = prefs.readerName || "the reader";
  const record = await complete(
    { ...prefs, maxTokens: Math.max(prefs.maxTokens, 800) },
    {
      system: distilPrompt(name),
      paper: "",
      related: "",
      readerContext: "",
      turns: [{ role: "user", content: transcript(fresh, name, paperTitle(attachment)) }],
    }
  );
  if (!record) throw new Error("The model returned an empty draft.");

  const pages = pageRange(fresh);
  const lines = [
    `### ${localDate()}${pages ? ` · ${pages}` : ""}`,
    "",
    `*Distilled by Reading Partner (${prefs.model}) from a conversation in Zotero, and reviewed before filing.*`,
    "",
    record,
  ];
  if (session.pinnedPoints.length) {
    lines.push("", "**Pinned to the PDF:**", "");
    for (const p of session.pinnedPoints) {
      const where = p.pageLabel ? `p. ${p.pageLabel}, ` : "";
      const passage = p.passage ? `${where}on "${clip(p.passage, 160)}": ` : where;
      lines.push(`- ${passage}${p.text.replace(/\s*\n+\s*/g, " ")}`);
    }
  }

  await IOUtils.makeDirectory(target.dir, { createAncestors: true, ignoreExisting: true });
  const existing = await findPage(target.dir, parent.key);
  const path = existing ?? (await freePath(target.dir, readMeta(parent, attachment)));
  return {
    markdown: lines.join("\n"),
    path,
    exists: !!existing,
    relPath: `${target.folder}/${PathUtils.filename(path)}`,
  };
}

export async function writeWikiEntry(session: Session, draft: WikiDraft, markdown: string): Promise<void> {
  const prefs = getPrefs();
  const target = await vaultTarget(prefs);
  const attachment = session.attachment;
  const meta = readMeta(attachment.parentItem, attachment);
  const today = localDate();
  const entry = markdown.trim();

  // Re-check: the page may have been created since the draft was made.
  const existingPath = await findPage(target.dir, meta.zoteroKey);
  let content: string;
  if (existingPath) {
    draft.path = existingPath;
    content = insertEntry(await IOUtils.readUTF8(existingPath), entry, today);
  } else {
    content = newPage(meta, entry, today);
  }
  await IOUtils.writeUTF8(draft.path, content);

  const link = `${target.folder}/${PathUtils.filename(draft.path).replace(/\.md$/, "")}`;
  await appendLog(
    target.vault,
    existingPath ? "update" : "create",
    `${meta.shortAuthors} (${meta.year || "n.d."}): ${meta.title}`,
    existingPath
      ? `Reading conversation added to [[${link}]] by Reading Partner (${prefs.model}).`
      : `Source page [[${link}]] created by Reading Partner with a reading conversation and no summary yet. Status: unprocessed.`,
    today
  );
  session.markExported();
}

// ---------------------------------------------------------------------------
// The model call

function distilPrompt(name: string): string {
  return `You file records of reading conversations into a research wiki. You will get a conversation between ${name}, a postgraduate researcher, and their reading partner about one academic paper.

Write a short record of the conversation, not of the paper. The wiki page already summarises the paper; this record is for finding ${name}'s own thinking later.

- One paragraph, 80 to 160 words: what ${name} was working through and where the discussion landed. Attribute positions plainly ("${name} argued…", "the partner's counterpoint was…"), and quote ${name}'s own phrasing where it's distinctive.
- Then, if anything was left unresolved, a line reading "**Open questions:**" followed by one to four bullet points.
- Mention the paper's argument only where it's needed to make sense of ${name}'s point.
- Report only what was said. Don't say either side agreed, conceded or settled something unless they said so; an unresolved disagreement goes under open questions.
- No headings and no preamble. Output only the record, in Markdown and British English.`;
}

function transcript(messages: Message[], name: string, title: string): string {
  const body = messages
    .map((m) => {
      const who = m.role === "user" ? name : "Reading partner";
      const page = m.page ? ` [on p. ${m.page}]` : "";
      const focus = m.focus
        ? `\n> ${m.focus.text.replace(/\n/g, "\n> ")}${m.focus.pageLabel ? ` (p. ${m.focus.pageLabel})` : ""}`
        : "";
      return `${who}${m.role === "user" ? page : ""}:${focus}\n${m.content}`;
    })
    .join("\n\n");
  return `The paper is "${title}". The conversation:\n\n${body}\n\nNow write the record.`;
}

function pageRange(messages: Message[]): string {
  const labels = new Set<string>();
  for (const m of messages) {
    if (m.page) labels.add(m.page);
    if (m.focus?.pageLabel) labels.add(m.focus.pageLabel);
  }
  if (!labels.size) return "";
  const nums = [...labels].map(Number);
  if (nums.every((n) => Number.isFinite(n))) {
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return lo === hi ? `p. ${lo}` : `pp. ${lo}–${hi}`;
  }
  return `pp. ${[...labels].join(", ")}`;
}

// ---------------------------------------------------------------------------
// Editing the page

// Entries go at the end of our section. A page without the section gets it
// just above "## My notes" (the human-authored section, which stays last
// and is never touched), or at the end.
function insertEntry(page: string, entry: string, today: string): string {
  page = page.replace(/^updated:.*$/m, `updated: ${today}`);
  const at = page.indexOf(`\n${SECTION}`);
  if (at !== -1) {
    const after = at + SECTION.length + 1;
    const next = page.slice(after).search(/\n## /);
    const end = next === -1 ? page.length : after + next;
    return `${page.slice(0, end).replace(/\s*$/, "")}\n\n${entry}\n${page.slice(end)}`;
  }
  const section = `${SECTION}\n\n${SECTION_INTRO}\n\n${entry}\n`;
  const notes = page.indexOf("\n## My notes");
  if (notes !== -1) {
    return `${page.slice(0, notes).replace(/\s*$/, "")}\n\n${section}${page.slice(notes)}`;
  }
  return `${page.replace(/\s*$/, "")}\n\n${section}`;
}

const SECTION_INTRO =
  "*(Reading Partner: dated records of conversations about this paper in Zotero, reviewed before filing. Your own notes stay in My notes.)*";

// A page in the summariser's format, with an empty block between its markers
// for it to fill. Running its "Add to research wiki" later adds the summary
// and keeps everything else.
function newPage(meta: ItemMeta, entry: string, today: string): string {
  const fm: [string, string][] = [
    ["type", "source"],
    ["title", q(meta.title)],
    ["authors", list(meta.authors)],
    ["year", meta.year],
    ["item-type", meta.itemType],
    ["venue", meta.venue ? q(meta.venue) : ""],
    ["doi", meta.doi ? q(meta.doi) : ""],
    ["url", meta.url ? q(meta.url) : ""],
    ["citekey", q(meta.citekey)],
    ["zotero-key", meta.zoteroKey],
    ["zotero-link", q(meta.zoteroLink)],
    ["pdf-link", q(meta.pdfLink)],
    ["zotero-tags", list(meta.zoteroTags)],
    ["collections", list(meta.collections)],
    ["suggested-topics", "[]"],
    ["model", ""],
    ["added", meta.added],
    ["status", "unprocessed"],
    ["topics", "[]"],
    ["projects", "[]"],
    ["created", today],
    ["updated", today],
    ["tags", "[]"],
  ];
  const block = [
    START,
    `# ${meta.title}`,
    "",
    `Source page for ${meta.shortAuthors} (${meta.year || "n.d."}). Created by Reading Partner on ${today}, without a summary: run PDF Auto-Summariser's *Add to research wiki* on this item to add one.`,
    "",
    `[Open in Zotero](${meta.zoteroLink}) · [Open PDF](${meta.pdfLink})`,
    END,
  ].join("\n");
  return (
    `---\n${fm.map(([k, v]) => (v ? `${k}: ${v}` : `${k}:`)).join("\n")}\n---\n` +
    `\n${block}\n\n## Connections\n\n` +
    `*(Agent-maintained: the topics and projects this source bears on, and what it agrees or disagrees with.)*\n\n` +
    `${SECTION}\n\n${SECTION_INTRO}\n\n${entry}\n\n## My notes\n\n`
  );
}

async function appendLog(vault: string, op: string, title: string, what: string, today: string): Promise<void> {
  const logPath = PathUtils.join(vault, "log.md");
  let current = (await IOUtils.exists(logPath)) ? await IOUtils.readUTF8(logPath) : "# Log — research\n";
  current = current.replace(/\s*$/, "\n");
  await IOUtils.writeUTF8(logPath, `${current}\n## [${today}] ${op} | ${title}\n${what}\n`);
}

// ---------------------------------------------------------------------------
// Locating pages (as in the summariser)

async function findPage(dir: string, zoteroKey: string): Promise<string | null> {
  if (!(await IOUtils.exists(dir))) return null;
  for (const child of await IOUtils.getChildren(dir)) {
    if (child.endsWith(".md") && (await keyOf(child)) === zoteroKey) return child;
  }
  return null;
}

async function freePath(dir: string, meta: ItemMeta): Promise<string> {
  const preferred = PathUtils.join(dir, `${meta.citekey}.md`);
  if (!(await IOUtils.exists(preferred))) return preferred;
  return PathUtils.join(dir, `${meta.citekey}-${meta.zoteroKey.toLowerCase()}.md`);
}

async function keyOf(path: string): Promise<string | null> {
  try {
    const bytes = await IOUtils.read(path, { maxBytes: 8192 });
    const head = new TextDecoder().decode(bytes);
    return head.match(/^zotero-key:\s*"?([A-Z0-9]+)"?\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zotero metadata (copied from the summariser's vault.ts)

interface ItemMeta {
  title: string;
  authors: string[];
  shortAuthors: string;
  year: string;
  itemType: string;
  venue: string;
  doi: string;
  url: string;
  citekey: string;
  zoteroKey: string;
  zoteroLink: string;
  pdfLink: string;
  zoteroTags: string[];
  collections: string[];
  added: string;
}

const VENUE_FIELDS = [
  "publicationTitle", "proceedingsTitle", "bookTitle", "websiteTitle",
  "blogTitle", "forumTitle", "publisher", "institution", "university",
];

const STOPWORDS = new Set([
  "a", "an", "the", "of", "on", "in", "for", "and", "to", "from", "with",
  "by", "at", "is", "are", "towards", "toward",
]);

function readMeta(item: any, attachment: any): ItemMeta {
  const field = (name: string): string => {
    try {
      return String(item.getField(name) || "").trim();
    } catch {
      return "";
    }
  };
  const extra = field("extra");
  const creators: any[] = item.getCreatorsJSON?.() ?? [];
  const primary = creators.filter((c) => c.creatorType === "author");
  const people = primary.length ? primary : creators;
  const authors = people.map((c) =>
    c.name ? c.name : [c.lastName, c.firstName].filter(Boolean).join(", ")
  );
  const surnames = people.map((c) => c.lastName || c.name || "").filter(Boolean);
  const year = (field("date").match(/\b(\d{4})\b/) || [])[1] || "";
  const title = field("title") || "(untitled)";

  let venue = "";
  for (const f of VENUE_FIELDS) {
    venue = field(f);
    if (venue) break;
  }

  const lib = Zotero.Libraries.get(item.libraryID);
  const libPath = lib && lib.libraryType === "group" ? `groups/${lib.groupID}` : "library";

  return {
    title,
    authors,
    shortAuthors: shortAuthorList(surnames),
    year,
    itemType: item.itemType || Zotero.ItemTypes.getName(item.itemTypeID) || "",
    venue,
    doi: field("DOI") || extraValue(extra, "DOI"),
    url: field("url"),
    citekey: citekeyFor(item, extra, surnames[0], year, title),
    zoteroKey: item.key,
    zoteroLink: `zotero://select/${libPath}/items/${item.key}`,
    pdfLink: `zotero://open-pdf/${libPath}/items/${attachment.key}`,
    zoteroTags: (item.getTags?.() ?? []).map((t: any) => t.tag),
    collections: (item.getCollections?.() ?? [])
      .map((id: number) => Zotero.Collections.get(id)?.name)
      .filter(Boolean),
    added: String(item.dateAdded || "").slice(0, 10),
  };
}

function citekeyFor(item: any, extra: string, surname: string | undefined, year: string, title: string): string {
  let key = "";
  try {
    key = Zotero.BetterBibTeX?.KeyManager?.get(item.id)?.citationKey || "";
  } catch {
    /* BBT not installed or API changed */
  }
  if (!key) {
    try {
      key = item.getField("citationKey") || "";
    } catch {
      /* field not in this Zotero version */
    }
  }
  if (!key) key = extraValue(extra, "Citation Key");
  if (key) return key.replace(/[\\/:*?"<>|]/g, "-");

  const words = slugify(title)
    .split("-")
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 3);
  return [slugify(surname || "anon"), year || "nd", ...words].join("-");
}

function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extraValue(extra: string, label: string): string {
  const re = new RegExp(`^${label}:\\s*(.+)$`, "im");
  return (extra.match(re) || [])[1]?.trim() || "";
}

function shortAuthorList(surnames: string[]): string {
  if (surnames.length === 0) return "Unknown author";
  if (surnames.length === 1) return surnames[0];
  if (surnames.length === 2) return `${surnames[0]} and ${surnames[1]}`;
  return `${surnames[0]} et al.`;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function list(xs: string[]): string {
  return `[${xs.map(q).join(", ")}]`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return Services.dirsvc.get("Home", Ci.nsIFile).path + p.slice(1);
  }
  return p;
}

function localDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
