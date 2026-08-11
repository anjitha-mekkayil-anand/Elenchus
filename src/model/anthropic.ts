/**
 * AnthropicClient — real model calls via the Anthropic Messages API.
 * This is the application. (NF-3, design.md)
 *
 * The API key comes from the environment variable ANTHROPIC_API_KEY.
 * If absent, construction fails with a clear message naming the env var.
 */

import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export class AnthropicClient implements ModelClient {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { model?: string }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. " +
          "Set it in your environment or in .env (never commit the value)."
      );
    }
    this.apiKey = key;
    this.model = opts?.model ?? "claude-sonnet-4-20250514";
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Anthropic API error: HTTP ${response.status} — ${text}`
      );
    }

    const json = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textBlocks = json.content.filter((b) => b.type === "text");
    const content = textBlocks.map((b) => b.text).join("");

    return {
      content,
      model: json.model,
      usage: json.usage,
    };
  }
}
