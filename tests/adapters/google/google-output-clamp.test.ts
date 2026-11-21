import { describe, expect, test } from "bun:test";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import type { OcxParsedRequest } from "../../../src/types";
import { createGoogleAdapter, clampGoogleMaxOutputTokens, maxOutputTokensForGoogleModel } from "../../../src/adapters/google";

describe("google maxOutputTokens clamp", () => {
  test("returns model-specific max output tokens limit", () => {
    expect(maxOutputTokensForGoogleModel("gemini-3.7-flash")).toBe(65536);
    expect(maxOutputTokensForGoogleModel("gemini-3.7-flash-tiered")).toBe(65536);
    expect(maxOutputTokensForGoogleModel("gemini-3-pro")).toBe(65535);
    expect(maxOutputTokensForGoogleModel("claude-3-7-sonnet")).toBe(64000);
    expect(maxOutputTokensForGoogleModel("claude-3-5-sonnet@20241022")).toBe(64000);
    expect(maxOutputTokensForGoogleModel("gpt-oss-120b")).toBe(32768);
  });

  test("an unrecognized model has no invented ceiling", () => {
    // A cap we cannot justify silently truncates the operator's explicit request. Aliases,
    // gateway ids, and models newer than this table must pass through untouched.
    expect(maxOutputTokensForGoogleModel("custom-unknown-model")).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("custom-unknown-model", 128000)).toBe(128000);
    expect(maxOutputTokensForGoogleModel("some-gateway/gemini-3-pro")).toBeUndefined();
  });

  test("family matching does not fire on incidental substrings", () => {
    // "includes(pro)" matched my-prototype-model; "includes(oss)" matched crossover-v2.
    expect(maxOutputTokensForGoogleModel("my-prototype-model")).toBeUndefined();
    expect(maxOutputTokensForGoogleModel("crossover-v2")).toBeUndefined();
    expect(maxOutputTokensForGoogleModel("gemini-3-pro-preview")).toBe(65535);
    expect(maxOutputTokensForGoogleModel("gemini-3.5-flash")).toBe(65536);
  });

  test("downward clamps excessive requested tokens to model max", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 128000)).toBe(65536);
    expect(clampGoogleMaxOutputTokens("gemini-3-pro", 100000)).toBe(65535);
    expect(clampGoogleMaxOutputTokens("claude-3-7-sonnet", 100000)).toBe(64000);
    expect(clampGoogleMaxOutputTokens("gpt-oss-120b", 64000)).toBe(32768);
  });

  test("preserves requested tokens when within model max", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 4096)).toBe(4096);
    expect(clampGoogleMaxOutputTokens("gemini-3-pro", 8192)).toBe(8192);
    expect(clampGoogleMaxOutputTokens("claude-3-7-sonnet", 32000)).toBe(32000);
  });

  test("returns undefined when requested tokens is undefined or non-positive", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", undefined)).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 0)).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", -10)).toBeUndefined();
  });
});

describe("Gemini Developer API compatibility for existing clients", () => {
  const adapter = createGoogleAdapter(routedProviderConfig("google", {
    adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "fixture",
  }));
  const cases = [
    { id: "gemini-4-neon", effort: "xhigh" },
    { id: "gemini-4-hydrogen", effort: "xhigh" },
    { id: "gemini-4-carbon", effort: "high" },
    { id: "gemini-4-argon", effort: "high" },
  ];
  for (const { id, effort } of cases) {
    test(id + " preserves upstream sampling and the Gemini output clamp", async () => {
      for (const stream of [false, true]) {
        const parsed: OcxParsedRequest = {
          modelId: id, stream, context: { messages: [{ role: "user", content: "hi" }] },
          options: { reasoning: "xhigh", maxOutputTokens: 100000, temperature: 0.5, topP: 0.9 },
        };
        const request = await adapter.buildRequest(parsed);
        expect(new URL(request.url).pathname).toBe("/v1beta/models/" + id + ":" + (stream ? "streamGenerateContent" : "generateContent"));
        const config = JSON.parse(request.body).generationConfig;
        expect(config.thinkingConfig.thinkingLevel).toBe(effort);
        expect(config).toMatchObject({ maxOutputTokens: 65536, temperature: 0.5, topP: 0.9 });
      }
    });
  }

  test("a pinned 3.8 Flash still receives its original sampling parameters and output budget", async () => {
    const request = await adapter.buildRequest({
      modelId: "gemini-3.8-flash", stream: false, context: { messages: [{ role: "user", content: "hi" }] },
      options: { maxOutputTokens: 109, temperature: 0.4, topP: 0.75 },
    });
    expect(new URL(request.url).pathname).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(JSON.parse(request.body).generationConfig).toMatchObject({ maxOutputTokens: 109, temperature: 0.4, topP: 0.75 });
  });
});
