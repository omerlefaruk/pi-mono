import type { ExtensionAPI } from "../../../src/core/extensions/index.js";
import { createHaloExtension } from "../../../src/core/halo/extension.js";

export default function haloTraceOnly(pi: ExtensionAPI) {
	return createHaloExtension({ registerTools: false })(pi);
}
