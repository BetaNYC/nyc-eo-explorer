import { useSyncExternalStore } from "react";

import { getSnapshot, subscribe } from "./store.js";

/**
 * Read engine status. Instantiation itself is kicked off explicitly by App once
 * the manifest has loaded -- not from inside this hook -- so that the engine
 * download never blocks the first paint.
 */
export function useDuckDB() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
