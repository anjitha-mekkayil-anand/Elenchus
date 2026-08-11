/**
 * Unit tests for tasks 3.1–3.3 (Model interface).
 *
 * - RecordingClient writes a fixture to disk keyed by request hash.
 * - ReplayClient replays it by matching on request, not call order.
 * - AnthropicClient refuses to construct without ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model/types.js";
import type { Fixture } from "../src/model/recording.js";
import { RecordingClient, hashRequest } from "../src/model/recording.js";
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

  it("writes a fixture file keyed by request hash", async () => {
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

    // A fixture file should have been written with the hash as filename
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);

    const expectedKey = hashRequest(req);
    expect(files[0]).toBe(`${expectedKey}.json`);

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

  it("writes multiple fixture files for different requests", async () => {
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

  it("replays a recorded fixture matched by request content", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    const req: ModelRequest = {
      task: "retrieve",
      system: "You are an assistant.",
      messages: [{ role: "user", content: "Which pages?" }],
    };

    await recorder.complete(req);
    expect(fake.callCount).toBe(1);

    // Replay — matches on request content, no network
    const replayer = new ReplayClient(tmpDir);
    const response = await replayer.complete(req);

    expect(response.content).toBe('response to "retrieve"');
    expect(response.model).toBe("fake-model-1.0");
    // FakeClient was not called again
    expect(fake.callCount).toBe(1);
  });

  it("matches fixtures by request content regardless of call order", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    const reqA: ModelRequest = {
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "first" }],
    };
    const reqB: ModelRequest = {
      task: "decide",
      system: "sys",
      messages: [{ role: "user", content: "second" }],
    };

    // Record A then B
    await recorder.complete(reqA);
    await recorder.complete(reqB);

    // Replay in REVERSE order — should still match correctly
    const replayer = new ReplayClient(tmpDir);

    const r2 = await replayer.complete(reqB);
    expect(r2.content).toBe('response to "decide"');

    const r1 = await replayer.complete(reqA);
    expect(r1.content).toBe('response to "retrieve"');
  });

  it("throws with a clear error naming the task when no fixture matches", async () => {
    const fake = new FakeClient();
    const recorder = new RecordingClient(fake, tmpDir);

    await recorder.complete({
      task: "retrieve",
      system: "sys",
      messages: [{ role: "user", content: "recorded" }],
    });

    const replayer = new ReplayClient(tmpDir);

    // Request something that was never recorded
    await expect(
      replayer.complete({
        task: "decide",
        system: "sys",
        messages: [{ role: "user", content: "not recorded" }],
      })
    ).rejects.toThrow('task: "decide"');
  });
});
