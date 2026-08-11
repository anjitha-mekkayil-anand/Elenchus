/**
 * Unit tests for tasks 3.1–3.3 (Model interface).
 *
 * - RecordingClient writes a fixture to disk.
 * - ReplayClient replays it without making any network call.
 * - AnthropicClient refuses to construct without ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";
import type { Fixture } from "../src/model/recording.js";
import { RecordingClient } from "../src/model/recording.js";
import { ReplayClient } from "../src/model/replay.js";
import { AnthropicClient } from "../src/model/anthropic.js";

// A fake ModelClient that returns a canned response — no network.
class FakeClient implements ModelClient {
  callCount = 0;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    return {
      content: `response to "${req.task}"`,
      model: "fake-model-1.0",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
}

describe("AnthropicClient (task 3.1)", () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("throws with a clear message naming the env var when key is absent", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => new AnthropicClient()).toThrow("ANTHROPIC_API_KEY");
  });

  it("constructs successfully when key is present", () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const client = new AnthropicClient();
    expect(client).toBeDefined();
  });
});

describe("RecordingClient (task 3.2)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-fixtures-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a fixture file for each call", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    const req: ModelRequest = {
      task: "retrieve",
      system: "You are an assistant.",
      messages: [{ role: "user", content: "Which pages does this touch?" }],
    };

    const response = await recorder.complete(req);

    // Response should pass through from the inner client
    expect(response.content).toBe('response to "retrieve"');
    expect(response.model).toBe("fake-model-1.0");

    // A fixture file should have been written
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);

    // The fixture should contain the request and response
    const fixture: Fixture = JSON.parse(
      readFileSync(join(tmpDir, files[0]), "utf-8")
    );
    expect(fixture.request.task).toBe("retrieve");
    expect(fixture.request.system).toBe("You are an assistant.");
    expect(fixture.request.messages).toEqual(req.messages);
    expect(fixture.response.content).toBe('response to "retrieve"');
    expect(fixture.timestamp).toBeTruthy();
  });

  it("writes multiple fixture files for multiple calls", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    await recorder.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "first" }],
    });
    await recorder.complete({
      task: "decide",
      system: "sys",
      messages: [{ role: "user", content: "second" }],
    });

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
    expect(fake.callCount).toBe(2);
  });

  it("does not store API keys or secrets in fixtures", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    await recorder.complete({
      task: "plan",
      system: "sys",
      messages: [{ role: "user", content: "plan some edits" }],
    });

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    const content = readFileSync(join(tmpDir, files[0]), "utf-8");

    // The fixture should not contain any key-like patterns
    expect(content).not.toContain("api_key");
    expect(content).not.toContain("x-api-key");
    expect(content).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("ReplayClient (task 3.3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "elenchus-replay-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replays a recorded fixture without making network calls", async () => {
    // First, record a fixture using the FakeClient
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    const req: ModelRequest = {
      task: "retrieve",
      system: "You are an assistant.",
      messages: [{ role: "user", content: "Which pages?" }],
    };

    await recorder.complete(req);
    expect(fake.callCount).toBe(1);

    // Now replay — no network, no calls to the inner client
    const replayer = new ReplayClient(tmpDir);
    const response = await replayer.complete(req);

    expect(response.content).toBe('response to "retrieve"');
    expect(response.model).toBe("fake-model-1.0");
    // FakeClient was not called again — only once during recording
    expect(fake.callCount).toBe(1);
  });

  it("replays multiple fixtures in order", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    await recorder.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "first" }],
    });

    // Small delay to ensure distinct timestamps in filenames
    await new Promise((r) => setTimeout(r, 5));

    await recorder.complete({
      task: "decide",
      system: "sys",
      messages: [{ role: "user", content: "second" }],
    });

    const replayer = new ReplayClient(tmpDir);

    const r1 = await replayer.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "first" }],
    });
    expect(r1.content).toBe('response to "retrieve"');

    const r2 = await replayer.complete({
      task: "decide",
      system: "sys",
      messages: [{ role: "user", content: "second" }],
    });
    expect(r2.content).toBe('response to "decide"');
  });

  it("throws when no more fixtures are available", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    await recorder.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "only one" }],
    });

    const replayer = new ReplayClient(tmpDir);

    // First call succeeds
    await replayer.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "only one" }],
    });

    // Second call fails — no more fixtures
    await expect(
      replayer.complete({
        task: "decide",
        system: "sys",
        messages: [{ role: "user", content: "extra" }],
      })
    ).rejects.toThrow("no more fixtures to replay");
  });
});
