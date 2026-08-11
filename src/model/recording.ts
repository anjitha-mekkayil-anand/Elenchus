/**
 * RecordingClient — wraps any ModelClient and writes each request/response
 * pair to fixtures/ as a JSON file.
 *
 * Every real call made from day one becomes a free test case. That is the
 * reason to build this early. (design.md, task 3.2)
 *
 * If a recorded fixture would contain a key or secret in a request header,
 * those are never stored — only the logical request/response is persisted.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";

export interface Fixture {
  /** ISO timestamp of when the call was made. */
  timestamp: string;
  request: ModelRequest;
  response: ModelResponse;
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

    const filename = this.buildFilename(req);
    const filePath = resolve(this.fixturesDir, filename);
    writeFileSync(filePath, JSON.stringify(fixture, null, 2), "utf-8");

    return response;
  }

  private buildFilename(req: ModelRequest): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const task = req.task.replace(/[^a-z0-9]+/gi, "-").slice(0, 30);
    return `${ts}-${task}.json`;
  }
}
