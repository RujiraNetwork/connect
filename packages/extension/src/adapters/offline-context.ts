import { ClearSignContextType } from "@ledgerhq/context-module";

import type { ContextModule } from "@ledgerhq/context-module";

/** Device signing never downloads metadata, resolves names, or reports activity. */
export const offlineContext: ContextModule = {
  getContexts: () => Promise.resolve([]),
  getFieldContext: () =>
    Promise.resolve({
      type: ClearSignContextType.ERROR,
      error: new Error("Online signing metadata is unavailable offline"),
    }),
  getTypedDataFilters: () =>
    Promise.resolve({
      type: "error",
      error: new Error("Online signing metadata is unavailable offline"),
    }),
  report: () => Promise.resolve(),
  signReport: () => Promise.resolve(),
};
