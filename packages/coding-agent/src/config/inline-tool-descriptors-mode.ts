import { classifyModel } from "@oh-my-pi/pi-catalog/identity";

/**
 * Resolves whether full tool descriptors should be inlined into the system
 * prompt (and stripped from provider tool schemas) for a given model and
 * setting.
 *
 * `auto` inlines for Gemini except on Antigravity CLI, where the inline
 * inventory can trigger HTTP 429s. `on` and `off` explicitly override this.
 */
export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	modelId: string | undefined,
	provider: string | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return (
				provider !== "antigravity-cli" &&
				modelId !== undefined &&
				classifyModel("", modelId, { lenient: true }).class === "gemini"
			);
	}
}
