# Reading Partner for Zotero

A Zotero 7+ plugin that adds a dialogue partner to the PDF reader's right-hand pane. It is for thinking a paper through, in the manner of a supervision, rather than for summarising papers or automating a literature review. It reads the paper alongside your own highlights, comments and notes. When the conversation turns up something worth keeping, you can pin it and attach it to a passage as a highlight comment.

It has its own model settings, separate from the [PDF Auto-Summariser](https://github.com/grahmgaydos/Zotero-PDF-Summarizer), so the two can use different models.

## Using it

- **Open a PDF** and click the speech-bubble icon in the reader's right-hand side nav. The chat is a section of that pane, and the status line shows what's in context, for example "paper · 12 highlights · 2 notes".
- **Talk.** Enter sends and Shift+Enter starts a new line. Each paper has its own conversation, kept between sessions. **New** starts over, and **Save** writes the whole conversation to a child note.
- **Discuss a passage.** Select text in the PDF and choose **Discuss** in the popup, or right-click and choose **Discuss with Reading Partner**. The passage is attached to your next message. Right-clicking an annotation in the sidebar offers the same, with your comment included.
- **Pull an idea into the PDF.** On a reply, click **Pin** (or right-click → *Pin for a passage*). If you have selected part of the reply, only that part is pinned. Then select a passage in the PDF and choose **Add pinned point as comment**. This creates a highlight in your chosen colour with the pinned text as its comment. On an existing annotation, right-click → **Append pinned point to comment** does the same thing there.
- **Save as note** on a reply (or the selected part of it) adds it as a child note.
- **Read it against another paper.** **Readings** lists the other papers in this one's collections, plus any Zotero "Related" items. Tick the ones this paper responds to or argues with. Their text, and your highlights on them, join the conversation as secondary readings, for setting the texts against each other rather than summarising them. The status line counts them.
- **File it to the wiki.** **Wiki** drafts a record of the conversation for the paper's page in your research wiki. You edit the draft in the pane, and nothing is written until you click **File it**. See *Research wiki* below.

A conversation carries on across your reading. Each message records the page you were on, and when it has changed since your last message the model is told (for example, "I've moved on from p. 6 and I'm now on p. 14"). Your highlights and notes stay current too. Editing an annotation or note marks the context for rebuilding, and the next message includes the change. Notes saved with **Save** are excluded so the model isn't fed its own words.

## How the context is laid out (token use)

Every request is: system prompt → paper text → other readings → your highlights/comments/notes → conversation. The paper doesn't change during a conversation, and the other readings change only when you pick different ones, so they come before anything that changes more often:

- **Anthropic** sets cache breakpoints after the paper, after the other readings, and on the newest message. Follow-up turns then re-read the paper at the cached rate, and annotating only invalidates the small block after it. Each reply shows its token use (`23.1k in (21.0k cached) · 0.3k out`).
- **OpenAI** caches matching prefixes automatically. **Ollama** reuses its KV cache when the start of the prompt is unchanged, and the plugin sizes `num_ctx` per request, as the summariser does.

The paper is always read in full by default. **Max characters of paper text** is an optional cap for very long texts such as books (0, the default, means no cap). A capped paper keeps its opening, its end and the pages around where you were when the conversation started. The paper is read once per conversation and never re-read as you move, so later turns reuse the cache. **Max characters per other reading** (default 30,000) does cap each paper brought in with Readings, since they're secondary. Paper text carries `[p. N]` page markers, taken from the page breaks in Zotero's extracted text, so the model can cite real pages.

## The prompt

The built-in system prompt (`src/lib/prompt.ts`) asks the model to engage critically with whatever you raise, in both directions rather than disagreeing by reflex. It also asks for fairly short, conversational turns, a question back only when it helps, quotes with page numbers, a clear line between "what the paper says" and "what I think", and no summaries unless asked. You can override it in Settings → Reading Partner. Leave the field blank to keep the built-in one.

## Research wiki

**Wiki** turns the conversation since your last wiki entry into a short record: what you were working through, where it landed, open questions, and any points you pinned to the PDF, quoted word for word. It is a record of your thinking, not another summary of the paper. You review and edit it, then it goes into a `## Reading conversations` section on the paper's source page. That section sits above `## My notes`, which is never touched. `log.md` gets an entry too. The next **Wiki** covers only messages after that point.

**With the PDF Auto-Summariser.** The two plugins share the vault and its page format. They don't depend on each other's code; the shared format is documented in the vault's `CLAUDE.md`.
- If Reading Partner's own vault setting is blank, it uses the summariser's vault folder.
- It finds the paper's page the same way the summariser does, by `zotero-key` in the frontmatter, so renamed pages still match.
- The summariser regenerates only its frontmatter keys and the text between its `zotero-summariser` markers. Your conversation entries survive its re-runs.

**On its own.** Set **Vault folder** in Settings → Reading Partner, which overrides the summariser's setting even when both are installed. If a paper has no page yet, Reading Partner creates one in the same format: Zotero metadata, links, an empty summariser block, `status: unprocessed`, and your entry. If you install the summariser later, its *Add to research wiki* fills in the summary and keeps the rest.

## Backends: local or cloud

These are the same four as the summariser: Ollama (default), LM Studio, OpenAI / OpenRouter, and Anthropic. They're configured in **Settings → Reading Partner**, separately from the summariser. Replies stream in all four, and every feature (chat, readings, wiki drafts) goes through the same backend.

**Switching to a cloud API.** Pick the backend and the endpoint switches with it (unless you've typed your own), and Anthropic also gets a model name. Paste your key and click **Test connection**. Things to know:
- **Privacy:** a cloud backend receives the paper's text, any other readings, and your highlights and notes. Local backends keep everything on your machine.
- **Key storage:** the key is stored in plain text in your Zotero profile, as in the summariser.
- **Cost:** each message re-sends the paper. On Anthropic most of that is billed at the cache rate after the first turn, and each reply shows its token use, cached part included. Readings add to every message, so untick ones you're finished with.
- **Limits:** a cloud model's context window comfortably fits a whole paper plus a couple of readings. On Ollama the plugin raises the context window to fit, up to 64k tokens. A 40-page report plus one reading fits, but a book needs the cap.

**Local thinking models** (qwen3, deepseek-r1 and similar) are asked not to think (`think: false`). Otherwise they spend the whole reply budget reasoning and return nothing. Models that don't support the flag are retried without it.

## Development

```sh
npm install
npm run build        # bundle src/ → addon/content/index.js
npm run typecheck
npm run package      # dist/reading-partner-<version>.xpi + update.json entry
scripts/dev-link.sh link     # load addon/ live (quit Zotero first)
```

Logs: Help → Debug Output Logging, filter for `[Reading Partner]`. Release steps are the same as the summariser's (see its README).

### Layout

```
src/index.ts          startup/shutdown, notifier that marks context dirty
src/lib/pane.ts       the chat section (ItemPaneManager.registerSection)
src/lib/reader.ts     reader hooks: selection popup, page and annotation context menus
src/lib/session.ts    per-PDF conversation, sending, persistence
src/lib/context.ts    paper text, other readings, highlights/comments/notes → prompt blocks
src/lib/backends.ts   streaming chat for Ollama / OpenAI-compatible / Anthropic
src/lib/writeback.ts  pin, highlight-with-comment, notes
src/lib/wiki.ts       research-wiki entries (shares the summariser's page format)
src/lib/pdf.ts        text extraction (copied from the summariser)
src/lib/markdown.ts   minimal, DOM-only Markdown for replies
```

### Known rough edges

- The page's right-click menu doesn't receive the text selection, so `reader.ts` reads it from the reader's internal state (`_internalReader._state`). If a Zotero update moves that, the right-click items disappear, and the selection-popup buttons still work.
- Text extraction doesn't keep page numbers in the paper text. Page numbers reach the model through your annotations and quoted passages.
- Wiki drafts from small local models sometimes overstate agreement ("the pair agreed…"). That's what the review step is for, and larger models do better.
- Highlights on a brought-in reading are read when you pick it. Ones you add later appear after you re-pick it in Readings.
- The chat is an item pane section, so it scrolls with the other sections. The side-nav icon (and **Discuss**) jumps to it.
