/**
 * Tiny zero-dependency typed event emitter.
 * Avoids pulling in 'events' so the package works in edge runtimes,
 * Workers, and any non-Node JS environment.
 */
import type { LumiEventName, LumiEventPayload, LumiHandler } from "./types.js";

export class TypedEmitter {
  private handlers: { [K in LumiEventName]?: Set<LumiHandler<K>> } = {};

  on<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    if (!this.handlers[event]) this.handlers[event] = new Set();
    (this.handlers[event] as Set<LumiHandler<E>>).add(handler);
  }

  off<E extends LumiEventName>(event: E, handler: LumiHandler<E>): void {
    this.handlers[event]?.delete(handler as never);
  }

  emit<E extends LumiEventName>(event: E, payload: LumiEventPayload<E>): void {
    const set = this.handlers[event] as Set<LumiHandler<E>> | undefined;
    if (!set) return;
    // Copy to avoid mutation-during-iteration issues if a handler calls off().
    for (const h of [...set]) {
      try { h(payload); } catch (_e) { /* swallow handler errors */ }
    }
  }
}
