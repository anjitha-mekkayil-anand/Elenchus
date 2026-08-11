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

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelClient, ModelRequest, ModelResponse } from "./types.js";
import type { Fixture } from "./recording.js";

export class ReplayClient implements ModelClient {
  private readonly fixtures: Fixture[];
  private callIndex = 0;

  constructor(fixturesDir: string) {
    const files = readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    this.fixtures = files.map((f) => {
      const raw = readFileSync(resolve(fixturesDir, f), "utf-8");
      return JSON.parse(raw) as Fixture;
    });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (this.callIndex >= this.fixtures.length) {
      throw new Error(
        `ReplayClient: no more fixtures to replay. ` +
          `Expected call #${this.callIndex + 1} (task: "${req.task}") ` +
          `but only ${this.fixtures.length} fixture(s) available.`
      );
    }

    const fixture = this.fixtures[this.callIndex];
    this.callIndex++;

    return fixture.response;
  }
}
