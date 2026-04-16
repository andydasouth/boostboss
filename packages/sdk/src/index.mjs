// ESM shim that re-exports the CJS entry.
import cjs from "./index.js";
export const BoostBoss = cjs.BoostBoss;
export const getSponsoredContent = cjs.getSponsoredContent;
export const trackEvent = cjs.trackEvent;
export const configure = cjs.configure;
export const SDK_VERSION = cjs.SDK_VERSION;
export default cjs;
