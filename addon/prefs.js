// Default preferences. Read by Zotero on startup; user values override.
// Branch prefix matches what the TS code uses: extensions.reading-partner.*
// Deliberately separate from the PDF Auto-Summariser's branch, so the two can
// run different models.

pref("extensions.reading-partner.backend", "ollama");
pref("extensions.reading-partner.endpoint", "http://localhost:11434/v1/chat/completions");
pref("extensions.reading-partner.model", "llama3.1:8b");
pref("extensions.reading-partner.apiKey", "");
// 0 = always read the whole paper.
pref("extensions.reading-partner.maxChars", 0);
pref("extensions.reading-partner.relatedMaxChars", 30000);
pref("extensions.reading-partner.maxTokens", 1024);
pref("extensions.reading-partner.highlightColor", "#a28ae5");
pref("extensions.reading-partner.includeNotes", true);
pref("extensions.reading-partner.prompt", "");
// Blank: use the PDF Auto-Summariser's vault (extensions.pdf-auto-summariser.vaultPath).
pref("extensions.reading-partner.vaultPath", "");
pref("extensions.reading-partner.vaultSourcesFolder", "");
pref("extensions.reading-partner.readerName", "");
