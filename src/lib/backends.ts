// Model backends, adapted from the PDF Auto-Summariser for multi-turn,
// streamed chat. Three code paths: Ollama's native chat API,
// OpenAI-compatible (LM Studio, OpenAI, OpenRouter), and the Anthropic
// Messages API.
//
// Every request has the same layout, so all three backends can reuse work
// from the previous turn:
//
//   system prompt → paper text → other readings → highlights/notes → conversation
//
// The paper never changes during a conversation and the other readings
// rarely do, so they sit before the highlights, which change as you read. Anthropic gets explicit cache
// breakpoints; OpenAI caches matching prefixes automatically; Ollama reuses
// its KV cache when the start of the prompt is unchanged.

import type { Prefs } from "./prefs";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  /** Paper text, framed. Stable for the whole conversation. */
  paper: string;
  /** Other readings brought in for comparison. Changes only when the set does. */
  related: string;
  /** Highlights, comments and notes. Changes as the user annotates. */
  readerContext: string;
  turns: ChatTurn[];
}

export interface Usage {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
}

export type OnDelta = (text: string) => void;

export async function streamChat(
  prefs: Prefs,
  req: ChatRequest,
  onDelta: OnDelta,
  signal?: AbortSignal
): Promise<Usage> {
  if (prefs.backend === "anthropic") return streamAnthropic(prefs, req, onDelta, signal);
  if (prefs.backend === "ollama") return streamOllama(prefs, req, onDelta, signal);
  return streamOpenAICompatible(prefs, req, onDelta, signal);
}

/** One-off request (wiki drafts, connection test), collected into a string. */
export async function complete(prefs: Prefs, req: ChatRequest): Promise<string> {
  let out = "";
  await streamChat(prefs, req, (t) => (out += t));
  return out.trim();
}

// Used by the prefs pane's Test connection button.
export async function testConnection(prefs: Prefs): Promise<boolean> {
  const out = await complete(
    { ...prefs, maxTokens: 10 },
    {
      system: "You reply with a single word: OK.",
      paper: "",
      related: "",
      readerContext: "",
      turns: [{ role: "user", content: "Say OK." }],
    }
  );
  return out.length > 0;
}

// One system message for backends without structured system blocks.
function flatSystem(req: ChatRequest): string {
  return [req.system, req.paper, req.related, req.readerContext].filter(Boolean).join("\n\n");
}

async function streamOpenAICompatible(
  prefs: Prefs,
  req: ChatRequest,
  onDelta: OnDelta,
  signal?: AbortSignal
): Promise<Usage> {
  const body: any = {
    model: prefs.model,
    messages: [{ role: "system", content: flatSystem(req) }, ...req.turns],
    temperature: 0.7,
    max_tokens: prefs.maxTokens,
    stream: true,
  };
  // LM Studio and some proxies reject unknown fields, so only ask the
  // hosted APIs for usage figures.
  if (prefs.backend === "openai") body.stream_options = { include_usage: true };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (prefs.apiKey) headers["Authorization"] = `Bearer ${prefs.apiKey}`;

  const res = await post(prefs.endpoint, headers, body, signal);
  const usage: Usage = {};
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    const json = parse(data);
    // OpenRouter, LM Studio and proxies can report a failure inside a 200
    // stream instead of with an HTTP status.
    if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const delta = json?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) onDelta(delta);
    if (json?.usage) {
      usage.inputTokens = json.usage.prompt_tokens;
      usage.cachedTokens = json.usage.prompt_tokens_details?.cached_tokens;
      usage.outputTokens = json.usage.completion_tokens;
    }
  }
  return usage;
}

// Ollama's default context window is 4,096 tokens, and it drops overflow from
// the START of the prompt without any error, which here would be the system
// prompt and the opening of the paper. Its OpenAI-compatible endpoint ignores
// context options, so we use the native /api/chat endpoint and size num_ctx
// to each request.
async function streamOllama(
  prefs: Prefs,
  req: ChatRequest,
  onDelta: OnDelta,
  signal?: AbortSignal
): Promise<Usage> {
  const url = ollamaNativeUrl(prefs.endpoint);
  if (!url) {
    log(
      `Ollama endpoint ${prefs.endpoint} isn't a recognisable Ollama URL; ` +
        `using it as OpenAI-compatible, so the context window can't be set`
    );
    return streamOpenAICompatible(prefs, req, onDelta, signal);
  }

  const system = flatSystem(req);
  const chars = system.length + req.turns.reduce((n, t) => n + t.content.length, 0);
  // Thinking models (qwen3, deepseek-r1…) otherwise spend the whole reply
  // budget reasoning and return nothing; a conversational turn doesn't need
  // it. Models without thinking may reject the flag, so retry without it.
  const body: any = {
    model: prefs.model,
    think: false,
    messages: [{ role: "system", content: system }, ...req.turns],
    stream: true,
    options: {
      temperature: 0.7,
      num_predict: prefs.maxTokens,
      num_ctx: contextWindowFor(chars, prefs.maxTokens),
    },
  };

  let res: Response;
  try {
    res = await post(url, { "Content-Type": "application/json" }, body, signal);
  } catch (e: any) {
    if (!/think/i.test(e?.message || "")) throw e;
    delete body.think;
    res = await post(url, { "Content-Type": "application/json" }, body, signal);
  }
  const usage: Usage = {};
  let thought = false;
  // Native streaming is newline-delimited JSON, not SSE.
  for await (const line of lines(res)) {
    const json = parse(line);
    if (!json) continue;
    if (json.error) throw new Error(String(json.error));
    const delta = json.message?.content;
    if (typeof delta === "string" && delta) onDelta(delta);
    if (json.message?.thinking) thought = true;
    if (json.done) {
      usage.inputTokens = json.prompt_eval_count;
      usage.outputTokens = json.eval_count;
    }
  }
  if (thought && !usage.outputTokens) log("model produced only thinking");
  return usage;
}

// Map the configured endpoint (normally the OpenAI-style default,
// http://localhost:11434/v1/chat/completions) to Ollama's native chat URL.
// Returns null for URLs we can't map, e.g. a proxy with a custom path.
export function ollamaNativeUrl(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api/chat")) return u.toString();
  if (path === "" || path.endsWith("/v1/chat/completions") || path.endsWith("/v1")) {
    u.pathname = path.replace(/\/v1(\/chat\/completions)?$/, "") + "/api/chat";
    return u.toString();
  }
  return null;
}

// Conservative: English prose averages about 4 characters per token, so
// dividing by 3 overestimates and leaves headroom.
const CHARS_PER_TOKEN = 3;
const MIN_CONTEXT = 4096;
// Larger windows cost memory. 64k fits a whole 40-page report plus a second
// reading on a ~9B model; longer texts need a cap in settings.
const MAX_CONTEXT = 65536;

// Rounds up to a power of two so the size rarely changes mid-conversation.
// Ollama reloads the model whenever num_ctx changes, which costs several
// seconds and throws away the cached prefix.
export function contextWindowFor(promptChars: number, maxTokens: number): number {
  const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + maxTokens + 256;
  let ctx = MIN_CONTEXT;
  while (ctx < needed && ctx < MAX_CONTEXT) ctx *= 2;
  if (needed > ctx) {
    log(
      `Prompt needs ~${needed} tokens but the context is capped at ${ctx}; ` +
        `Ollama will drop the start of the paper. Set "Max characters of paper text" in settings.`
    );
  }
  return ctx;
}

async function streamAnthropic(
  prefs: Prefs,
  req: ChatRequest,
  onDelta: OnDelta,
  signal?: AbortSignal
): Promise<Usage> {
  if (!prefs.apiKey) throw new Error("Anthropic backend requires an API key");

  // Default endpoint if user left the OpenAI-shaped default in place.
  const url = prefs.endpoint.includes("api.anthropic.com")
    ? prefs.endpoint
    : "https://api.anthropic.com/v1/messages";

  // Breakpoints after the paper and after the other readings cache those,
  // which survives edits to the highlights; adding a reading re-caches only
  // from the paper on. The one on the newest message caches the conversation
  // so far for the next turn.
  const cached = { type: "ephemeral" };
  const system: any[] = [{ type: "text", text: req.system }];
  if (req.paper) system.push({ type: "text", text: req.paper, cache_control: cached });
  if (req.related) system.push({ type: "text", text: req.related, cache_control: cached });
  if (req.readerContext) system.push({ type: "text", text: req.readerContext });

  const messages: any[] = req.turns.map((t) => ({ role: t.role, content: t.content }));
  const last = messages[messages.length - 1];
  if (last) {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  }

  const res = await post(
    url,
    {
      "Content-Type": "application/json",
      "x-api-key": prefs.apiKey,
      "anthropic-version": "2023-06-01",
    },
    { model: prefs.model, max_tokens: prefs.maxTokens, system, messages, stream: true },
    signal
  );

  const usage: Usage = {};
  for await (const data of sseData(res)) {
    const json = parse(data);
    if (!json) continue;
    if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
      onDelta(json.delta.text);
    } else if (json.type === "message_start") {
      const u = json.message?.usage ?? {};
      usage.inputTokens =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.cachedTokens = u.cache_read_input_tokens;
    } else if (json.type === "message_delta") {
      usage.outputTokens = json.usage?.output_tokens;
    } else if (json.type === "error") {
      throw new Error(json.error?.message || "Anthropic stream error");
    }
  }
  return usage;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res;
}

async function* lines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("Response has no body to stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf.trim();
}

// The `data:` payloads of a server-sent event stream. Event names aren't
// needed: Anthropic repeats the type inside each payload.
async function* sseData(res: Response): AsyncGenerator<string> {
  for await (const line of lines(res)) {
    if (line.startsWith("data:")) yield line.slice(5).trim();
  }
}

function parse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function log(msg: string): void {
  Zotero.debug(`[Reading Partner] ${msg}`);
}
