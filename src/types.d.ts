// Minimal ambient declarations for the Zotero internal API we use.
// The community types at zotero-types are more complete; this is just enough
// for our own code to type-check without pulling in the full dependency.

declare const Zotero: any;
declare const Cc: any;
declare const Ci: any;
declare const Services: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const IOUtils: any;
declare const PathUtils: any;

// Bootstrap context (passed to startup/shutdown)
declare interface BootstrapData {
  id: string;
  version: string;
  rootURI: string;
}
