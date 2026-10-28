// Typed accessor over Zotero.Prefs for our preference branch.

import { DEFAULT_PROMPT } from "./prompt";

const BRANCH = "extensions.reading-partner";

export type Backend = "ollama" | "lmstudio" | "openai" | "anthropic";

export interface Prefs {
  backend: Backend;
  endpoint: string;
  model: string;
  apiKey: string;
  /** Optional cap on the paper's text; 0 means read the whole paper. */
  maxChars: number;
  /** Per other reading brought into a conversation. */
  relatedMaxChars: number;
  maxTokens: number;
  highlightColor: string;
  includeNotes: boolean;
  /** The system prompt actually used: the user's override, or the built-in one. */
  prompt: string;
  /** Blank means: use the PDF Auto-Summariser's vault settings. */
  vaultPath: string;
  vaultSourcesFolder: string;
  /** How wiki entries refer to the reader; blank means "the reader". */
  readerName: string;
}

export function getPrefs(): Prefs {
  const get = (k: string, def?: any) => {
    try {
      const v = Zotero.Prefs.get(`${BRANCH}.${k}`, true);
      return v === undefined || v === null ? def : v;
    } catch {
      return def;
    }
  };

  const prompt = String(get("prompt", "")).trim();
  return {
    backend: get("backend", "ollama") as Backend,
    endpoint: get("endpoint", "http://localhost:11434/v1/chat/completions"),
    model: get("model", "llama3.1:8b"),
    apiKey: get("apiKey", ""),
    maxChars: Number(get("maxChars", 0)),
    relatedMaxChars: Number(get("relatedMaxChars", 30000)),
    maxTokens: Number(get("maxTokens", 1024)),
    highlightColor: get("highlightColor", "#a28ae5"),
    includeNotes: Boolean(get("includeNotes", true)),
    prompt: prompt || DEFAULT_PROMPT,
    vaultPath: String(get("vaultPath", "")).trim(),
    vaultSourcesFolder: String(get("vaultSourcesFolder", "")).trim(),
    readerName: String(get("readerName", "")).trim(),
  };
}
