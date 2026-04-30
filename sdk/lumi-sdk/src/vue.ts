/**
 * @boostbossai/lumi-sdk/vue — Vue 3 bindings.
 *
 * Usage:
 *   <script setup lang="ts">
 *   import { LumiSlot, provideLumi } from "@boostbossai/lumi-sdk/vue";
 *   provideLumi({ publisherId: "pub_xxx" });
 *   </script>
 *   <template>
 *     <LumiSlot format="banner" context="onboarding flow" />
 *   </template>
 *
 * `vue` is a peer dependency. Install in your app: `npm i vue`.
 */

import {
  defineComponent, h, inject, onBeforeUnmount, onMounted, provide, ref, watch,
  type PropType, type Ref,
} from "vue";
import { Lumi } from "./lumi.js";
import type { LumiOptions, RenderOptions } from "./types.js";

const LUMI_KEY = Symbol.for("@boostbossai/lumi-sdk/vue");

/**
 * Initialise + register a Lumi instance for descendant <LumiSlot /> components.
 * Call once in a root component (or your main App component's <script setup>).
 * Returns the Lumi instance so you can also use it imperatively.
 */
export function provideLumi(opts: LumiOptions | Lumi): Lumi {
  const lumi: Lumi = opts instanceof Lumi ? opts : new Lumi(opts);
  provide(LUMI_KEY, lumi);
  return lumi;
}

/** Composable: access the Lumi instance provided by an ancestor. */
export function useLumi(): Lumi {
  const lumi = inject<Lumi | null>(LUMI_KEY, null);
  if (!lumi) throw new Error("useLumi() requires provideLumi() to have been called by an ancestor.");
  return lumi;
}

export const LumiSlot = defineComponent({
  name: "LumiSlot",
  props: {
    format:       { type: String as PropType<RenderOptions["format"]>, default: "banner" },
    context:      { type: String, default: "" },
    sessionId:    { type: String, default: undefined },
    userLanguage: { type: String, default: undefined },
    userRegion:   { type: String, default: undefined },
    hostApp:      { type: String, default: undefined },
    surface:      { type: String, default: undefined },
  },
  setup(props) {
    const lumi    = useLumi();
    const slot    = ref<HTMLDivElement | null>(null) as Ref<HTMLDivElement | null>;

    function mount(): void {
      const el = slot.value;
      if (!el) return;
      void lumi.render(el, {
        format:       props.format,
        context:      props.context,
        sessionId:    props.sessionId,
        userLanguage: props.userLanguage,
        userRegion:   props.userRegion,
        hostApp:      props.hostApp,
        surface:      props.surface,
      });
    }

    onMounted(mount);
    watch(
      () => [props.format, props.context, props.sessionId, props.surface, props.hostApp],
      () => { mount(); },
    );

    onBeforeUnmount(() => {
      const el = slot.value;
      if (el) el.innerHTML = "";
    });

    return () => h("div", { ref: slot });
  },
});
