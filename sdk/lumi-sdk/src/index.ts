/**
 * @boostbossai/lumi-sdk — main entry.
 *
 * For the React component:  import { LumiSlot, LumiProvider } from "@boostbossai/lumi-sdk/react";
 * For the Vue component:    import { LumiSlot } from "@boostbossai/lumi-sdk/vue";
 */
export { Lumi } from "./lumi.js";
export { ERROR_CODES, type ErrorCode } from "./errors.js";
export type {
  LumiOptions, RenderOptions, AdPayload,
  LumiEventName, LumiHandler,
  LumiImpressionEvent, LumiClickEvent, LumiCloseEvent,
  LumiNoFillEvent, LumiErrorEvent, LumiReadyEvent,
} from "./types.js";
