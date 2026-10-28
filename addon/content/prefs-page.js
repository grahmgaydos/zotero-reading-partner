/* eslint-disable no-undef */
// External script for the prefs pane. Loaded via the `scripts` parameter
// to PreferencePanes.register, which runs it in the pane's actual document
// context (unlike inline <script> tags, which don't reliably execute).

(function () {
  function wireUp() {
    const btn = document.getElementById("rpp-test-btn");
    const result = document.getElementById("rpp-test-result");
    const prompt = document.getElementById("rpp-prompt");
    const api = Zotero.ReadingPartner;
    if (prompt && api) prompt.placeholder = api.defaultPrompt;
    wireBackendDefaults();
    const shared = document.getElementById("rpp-shared-vault");
    const sharedPath = Zotero.Prefs.get("extensions.pdf-auto-summariser.vaultPath", true);
    if (shared && sharedPath) shared.textContent = sharedPath;
    if (!btn || btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";

    btn.addEventListener("click", async () => {
      result.textContent = "Testing…";
      result.style.color = "";
      try {
        if (!Zotero.ReadingPartner) {
          result.style.color = "red";
          result.textContent = "Plugin not loaded";
          return;
        }
        const ok = await Zotero.ReadingPartner.testConnection();
        result.style.color = ok ? "green" : "red";
        result.textContent = ok ? "OK ✓" : "Failed (empty response)";
      } catch (e) {
        result.style.color = "red";
        result.textContent = "Failed: " + (e && e.message ? e.message : String(e));
      }
    });
  }

  // Switching backend swaps in that backend's endpoint (and, for Anthropic,
  // a model name) unless you've typed your own, so a cloud backend doesn't
  // end up pointed at Ollama's URL.
  const DEFAULTS = {
    ollama: { endpoint: "http://localhost:11434/v1/chat/completions", model: "llama3.1:8b" },
    lmstudio: { endpoint: "http://localhost:1234/v1/chat/completions", model: "" },
    openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "" },
    anthropic: { endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5-5" },
  };
  const isDefault = (field, value) =>
    !value || Object.values(DEFAULTS).some((d) => d[field] === value);

  function wireBackendDefaults() {
    const backend = document.getElementById("rpp-backend");
    if (!backend || backend.dataset.wired === "1") return;
    backend.dataset.wired = "1";
    backend.addEventListener("change", () => {
      const d = DEFAULTS[backend.value];
      if (!d) return;
      for (const field of ["endpoint", "model"]) {
        const input = document.getElementById(`rpp-${field}`);
        if (!input || !isDefault(field, input.value)) continue;
        input.value = d[field];
        Zotero.Prefs.set(`extensions.reading-partner.${field}`, d[field], true);
      }
    });
  }

  // Zotero runs this script before it inserts the pane's markup, so the
  // elements don't exist yet. It fires a (non-bubbling) "showing" event on
  // the pane's children each time the pane is shown; catch it in the capture
  // phase and wire up then. wireUp is idempotent.
  document.addEventListener("showing", wireUp, true);
  wireUp();
})();
