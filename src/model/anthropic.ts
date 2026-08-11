/**
 * AnthropicClient — real model calls via the official Anthropic SDK.
 * This is the application. (NF-3, design.md)
 *
 * The API key comes from the environment variable ANTHROPIC_API_KEY.
 * If absent, construction fails with a clear message naming the env var.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts?: { model?: string }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. " +
          "Set it in your environment or in .env (never commit the value)."
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = opts?.model ?? "claude-opus-5";
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const textBlocks = message.content.filter((b) => b.type === "text");
    const content = textBlocks.map((b) => b.text).join("");

    return {
      content,
      model: message.model,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
      },
    };
  }
}
