import { describe, expect, test } from "bun:test";
import { shouldInlineToolDescriptors } from "@oh-my-pi/pi-coding-agent/config/inline-tool-descriptors-mode";

describe("shouldInlineToolDescriptors", () => {
	test("honors explicit on and off regardless of model", () => {
		expect(shouldInlineToolDescriptors("on", "claude-opus-4-8", "anthropic")).toBe(true);
		expect(shouldInlineToolDescriptors("on", undefined, undefined)).toBe(true);
		expect(shouldInlineToolDescriptors("off", "gemini-3-pro", "google-gemini-cli")).toBe(false);
	});

	test("auto inlines for Gemini models", () => {
		expect(shouldInlineToolDescriptors("auto", "gemini-3-pro", "google-gemini-cli")).toBe(true);
		expect(shouldInlineToolDescriptors("auto", "gemini-3.1-flash", "google-gemini-cli")).toBe(true);
		// Namespaced/aggregator ids fold onto the gemini lineage too.
		expect(shouldInlineToolDescriptors("auto", "google-gemini-cli/gemini-3-pro", "openrouter")).toBe(true);
	});

	test("auto keeps Antigravity CLI Gemini descriptions in provider schemas", () => {
		const modelId = "gemini-3.8-flash";
		expect(shouldInlineToolDescriptors("auto", modelId, "antigravity-cli")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", modelId, "google-gemini-cli")).toBe(true);
		expect(shouldInlineToolDescriptors("on", modelId, "antigravity-cli")).toBe(true);
	});

	test("auto stays off for non-Gemini models and missing model", () => {
		expect(shouldInlineToolDescriptors("auto", "claude-opus-4-8", "anthropic")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", "gpt-5.4", "openai")).toBe(false);
		expect(shouldInlineToolDescriptors("auto", undefined, undefined)).toBe(false);
	});

	test("undefined setting defaults to auto", () => {
		expect(shouldInlineToolDescriptors(undefined, "gemini-3-pro", "google-gemini-cli")).toBe(true);
		expect(shouldInlineToolDescriptors(undefined, "claude-opus-4-8", "anthropic")).toBe(false);
	});
});
