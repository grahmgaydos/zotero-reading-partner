/* eslint-disable no-undef */
// Zotero 7 bootstrapped plugin entry point.
// Loaded directly by Zotero. Must be plain JS (not a module).
// We bundle our TypeScript source into a single classic script at build time
// and load it from this file via Services.scriptloader.

var ReadingPartner; // global hook into our bundled code
var chromeHandle;

function log(msg) {
  Zotero.debug(`[Reading Partner] ${msg}`);
}

async function install() {
  log("install()");
}

async function startup({ id, version, rootURI }) {
  log(`startup() id=${id} version=${version} rootURI=${rootURI}`);

  await Zotero.initializationPromise;

  // chrome://reading-partner/content/ for the pane stylesheet and icons.
  var aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Ci.amIAddonManagerStartup
  );
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "reading-partner", rootURI + "content/"],
  ]);

  try {
    Services.scriptloader.loadSubScript(rootURI + "content/index.js", this);
  } catch (e) {
    log(`ERROR loading content/index.js: ${e}\n${e.stack || ""}`);
    return;
  }

  if (typeof ReadingPartner === "undefined") {
    log("ERROR: ReadingPartner bundle did not attach to global scope");
    return;
  }

  try {
    await ReadingPartner.startup({ id, version, rootURI });
  } catch (e) {
    log(`startup error: ${e}\n${e.stack || ""}`);
  }
}

function onMainWindowLoad({ window }) {
  if (typeof ReadingPartner !== "undefined") ReadingPartner.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  if (typeof ReadingPartner !== "undefined") ReadingPartner.onMainWindowUnload(window);
}

async function shutdown() {
  log("shutdown()");
  try {
    if (typeof ReadingPartner !== "undefined") {
      await ReadingPartner.shutdown();
    }
  } catch (e) {
    log(`shutdown error: ${e}`);
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall() {
  log("uninstall()");
}
