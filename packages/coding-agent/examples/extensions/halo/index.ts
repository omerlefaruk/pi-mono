import { createHaloExtension, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function halo(pi: ExtensionAPI) {
	return createHaloExtension()(pi);
}
