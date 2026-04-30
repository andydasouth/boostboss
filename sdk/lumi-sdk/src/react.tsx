/**
 * @boostbossai/lumi-sdk/react — React bindings.
 *
 * Usage:
 *   import { LumiProvider, LumiSlot } from "@boostbossai/lumi-sdk/react";
 *
 *   <LumiProvider publisherId="pub_xxx">
 *     <LumiSlot format="banner" context="onboarding flow" />
 *   </LumiProvider>
 *
 * `react` is a peer dependency. Install in your app: `npm i react`.
 */

import { createContext, useContext, useEffect, useRef, useMemo } from "react";
import type { ReactElement } from "react";
import { Lumi } from "./lumi.js";
import type { LumiOptions, RenderOptions } from "./types.js";

const LumiContext = createContext<Lumi | null>(null);

export interface LumiProviderProps extends LumiOptions {
  children: React.ReactNode;
  /**
   * Optional: bring your own Lumi instance (e.g. constructed elsewhere
   * for sharing across parts of the app). When provided, the other
   * props are ignored and the existing instance is used as-is.
   */
  instance?: Lumi;
}

/**
 * Provides a single Lumi instance to the React subtree. Use one
 * provider per app — typically at the root.
 */
export function LumiProvider(props: LumiProviderProps): ReactElement {
  const { children, instance, ...opts } = props;
  const lumi = useMemo<Lumi>(() => instance ?? new Lumi(opts as LumiOptions), [instance, opts.publisherId, opts.apiBase, opts.debug, opts.timeoutMs]);

  useEffect(() => {
    return () => {
      if (!instance) lumi.destroy();
    };
  }, [lumi, instance]);

  return <LumiContext.Provider value={lumi}>{children}</LumiContext.Provider>;
}

/** Hook: access the current Lumi instance. Throws if used outside a LumiProvider. */
export function useLumi(): Lumi {
  const lumi = useContext(LumiContext);
  if (!lumi) throw new Error("useLumi() must be used inside <LumiProvider>");
  return lumi;
}

export interface LumiSlotProps extends RenderOptions {
  /** Optional className applied to the rendered slot div. */
  className?: string;
  /** Optional inline style applied to the rendered slot div. */
  style?:     React.CSSProperties;
  /** Optional aria-label. Slots default to no label so screen readers don't double-announce. */
  ariaLabel?: string;
}

/**
 * Renders an ad slot. The component mounts a div, then asks Lumi to
 * render into it on mount and any time `format` or `context` changes.
 * Cleans up on unmount.
 */
export function LumiSlot(props: LumiSlotProps): ReactElement {
  const lumi = useLumi();
  const ref  = useRef<HTMLDivElement | null>(null);
  const { className, style, ariaLabel, ...renderOpts } = props;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void lumi.render(el, renderOpts).then(() => {
      if (cancelled) {
        // Component unmounted before render resolved — clean up.
        lumi.destroy();
      }
    });
    return () => {
      cancelled = true;
      // Best-effort: clear the DOM slot so React's reconciliation
      // doesn't re-paint over a stale ad on remount.
      if (el) el.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lumi, props.format, props.context, props.sessionId, props.surface, props.hostApp]);

  return <div ref={ref} className={className} style={style} aria-label={ariaLabel} />;
}
