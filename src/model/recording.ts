/**
 * RecordingClient — wraps any ModelClient and writes each request/response
 * pair to fixtures/ as a JSON file, keyed by a stable hash of the request.
 *
 * Every real call made from day one becomes a free test case. That is the
 * reason to build this early. (design.md, task 3.2)
 *
 * If a recorded fixture would contain a key or secret in a request header,
 * those are never stored — only the logical request/response is persisted.
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export interface Fixture {
  /** ISO timestamp of when the call was made. */
  timestamp: string;
  request: ModelRequest;
  response: ModelResponse;
}

/**
 * Produces a stable hash of a ModelRequest, used as the fixture filename.
 * This allows ReplayClient to look up fixtures by request content rather
 * than relying on call order.
 */
export function hashRequest(req: ModelRequest): string {
  const payload = JSON.stringify({
    task: req.task,
    system: req.system,
    messages: req.messages,
  });
  return createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 16);
}

export class RecordingClient implements ModelClient {
  private readonly inner: ModelClient;
  private readonly fixturesDir: string;

  constructor(inner: ModelClient, fixturesDir: string) {
    this.inner = inner;
    this.fixturesDir = fixturesDir;

    if (!existsSync(this.fixturesDir)) {
      mkdirSync(this.fixturesDir, { recursive: true });
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.complete(req);

    const fixture: Fixture = {
      timestamp: new Date().toISOString(),
      request: req,
      response,
    };

    const key = hashRequest(req);
    const filename = `${key}.json`;
    const filePath = resolve(this.fixturesDir, filename);
    writeFileSync(filePath, JSON.stringify(fixture, null, 2), "utf-8");

    return response;
  }
}
