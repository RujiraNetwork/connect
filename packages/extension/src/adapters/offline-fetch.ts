/** Vendor HTTP helpers are bundled as a local rejection, never an XHR polyfill. */
export const fetch: typeof globalThis.fetch = () =>
  Promise.reject(
    new Error("Rujira Connect works offline. Network access is disabled.")
  );
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export default fetch;
