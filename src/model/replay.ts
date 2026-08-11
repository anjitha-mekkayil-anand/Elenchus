/**
 * ⚠ BOUNDARY — ReplayClient is a TEST HARNESS.
 *
 * It is never presented as the application running. It exists so the
 * ingest loop can be tested offline and deterministically. It is
 * `npm test`. It is NOT a demo mode, is never shown as the app running,
 * and is never described as such in the README or the video.
 *
 * The rules forbid "simulated or hard-coded features presented as working
 * functionality" and treat a material gap between the demo and the real
 * project as grounds for disqualification. Judges run the real thing with
 * a supplied test credential.
 *
 * (design.md, task 3.3, NF-3)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";
import { hashRequest } from "./recording.js";
import type { Fixture } from "./recording.js";

export class ReplayClient implements ModelClient {
  private readonly fixturesByKey: Map<string, Fixture>;

  constructor(fixturesDir: string) {
    this.fixturesByKey = new Map();

    const files = readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".json"));

    for (const f of files) {
      const raw = readFileSync(resolve(fixturesDir, f), "utf-8");
      const fixture = JSON.parse(raw) as Fixture;
      const key = hashRequest(fixture.request);
      this.fixturesByKey.set(key, fixture);
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const key = hashRequest(req);
    const fixture = this.fixturesByKey.get(key);

    if (!fixture) {
      throw new Error(
        `ReplayClient: no fixture matches request (task: "${req.task}", key: ${key}). ` +
          `${this.fixturesByKey.size} fixture(s) available.`
      );
    }

    return fixture.response;
  }
}
