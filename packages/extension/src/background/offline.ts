import offlineFetch from "../adapters/offline-fetch";

/** SDK fallbacks use bundled data; HTTP never leaves the extension. CSP also blocks XHR and sockets. */
export function blockNetwork(): void {
  globalThis.fetch = offlineFetch;
}
