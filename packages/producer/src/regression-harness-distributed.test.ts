/**
 * Unit tests for the harness mode plumbing — `parseHarnessModeFlag`,
 * `checkDistributedSupport`, and `resolveMinPsnrForMode`.
 *
 * These do NOT exercise the render pipeline itself. The byte-identical-retry
 * contract is covered by `services/distributed/renderChunk.test.ts` and the
 * PSNR contract is covered by `Dockerfile.test` running the harness with
 * `--mode=distributed-simulated` against the smallest existing fixture.
 * What lives here is the dispatch logic that decides which mode runs and
 * which fixtures skip.
 */

import { describe, expect, it } from "bun:test";
import {
  checkDistributedSupport,
  DISTRIBUTED_SIMULATED_MIN_PSNR_DB,
  parseHarnessModeFlag,
  resolveMinPsnrForMode,
} from "./regression-harness-distributed.js";

describe("parseHarnessModeFlag()", () => {
  it("parses --mode=in-process", () => {
    expect(parseHarnessModeFlag("--mode=in-process")).toBe("in-process");
  });

  it("parses --mode=distributed-simulated", () => {
    expect(parseHarnessModeFlag("--mode=distributed-simulated")).toBe("distributed-simulated");
  });

  it("returns null for tokens that aren't --mode", () => {
    expect(parseHarnessModeFlag("--update")).toBeNull();
    expect(parseHarnessModeFlag("font-variant-numeric")).toBeNull();
    expect(parseHarnessModeFlag("--exclude-tags")).toBeNull();
  });

  it("throws on a known prefix with a bad value", () => {
    expect(() => parseHarnessModeFlag("--mode=foo")).toThrow(/--mode must be/);
    expect(() => parseHarnessModeFlag("--mode=")).toThrow(/--mode must be/);
  });
});

describe("checkDistributedSupport()", () => {
  it("accepts mp4 SDR at 24 / 30 / 60 fps", () => {
    for (const fpsNum of [24, 30, 60]) {
      const result = checkDistributedSupport({ fps: { num: fpsNum, den: 1 } });
      expect(result.supported).toBe(true);
    }
  });

  it("accepts explicit format=mp4", () => {
    const result = checkDistributedSupport({ fps: { num: 30, den: 1 }, format: "mp4" });
    expect(result.supported).toBe(true);
  });

  it("rejects fps with non-1 denominator (NTSC)", () => {
    const result = checkDistributedSupport({ fps: { num: 30000, den: 1001 } });
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toMatch(/non-integer fps/);
    }
  });

  it("rejects fps outside the {24,30,60} set", () => {
    for (const fpsNum of [12, 25, 48, 50, 120]) {
      const result = checkDistributedSupport({ fps: { num: fpsNum, den: 1 } });
      expect(result.supported).toBe(false);
      if (!result.supported) {
        expect(result.reason).toMatch(/not in \{24, 30, 60\}/);
      }
    }
  });

  it("rejects format=webm", () => {
    const result = checkDistributedSupport({ fps: { num: 30, den: 1 }, format: "webm" });
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toMatch(/webm/);
    }
  });

  it("rejects hdr=true", () => {
    const result = checkDistributedSupport({ fps: { num: 30, den: 1 }, hdr: true });
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toMatch(/hdr/);
    }
  });

  it("accepts hdr=false (or unset)", () => {
    expect(checkDistributedSupport({ fps: { num: 30, den: 1 }, hdr: false }).supported).toBe(true);
    expect(checkDistributedSupport({ fps: { num: 30, den: 1 } }).supported).toBe(true);
  });
});

describe("resolveMinPsnrForMode()", () => {
  it("in-process mode uses the fixture's own threshold verbatim", () => {
    expect(resolveMinPsnrForMode("in-process", 30)).toBe(30);
    expect(resolveMinPsnrForMode("in-process", 50)).toBe(50);
    expect(resolveMinPsnrForMode("in-process", 60)).toBe(60);
  });

  it("distributed-simulated raises sub-floor thresholds to the determinism floor", () => {
    expect(resolveMinPsnrForMode("distributed-simulated", 30)).toBe(
      DISTRIBUTED_SIMULATED_MIN_PSNR_DB,
    );
    expect(resolveMinPsnrForMode("distributed-simulated", 40)).toBe(
      DISTRIBUTED_SIMULATED_MIN_PSNR_DB,
    );
  });

  it("distributed-simulated leaves fixture thresholds ≥ floor unchanged", () => {
    expect(resolveMinPsnrForMode("distributed-simulated", 50)).toBe(50);
    expect(resolveMinPsnrForMode("distributed-simulated", 55)).toBe(55);
    expect(resolveMinPsnrForMode("distributed-simulated", 80)).toBe(80);
  });

  it("DISTRIBUTED_SIMULATED_MIN_PSNR_DB is the empirical determinism floor", () => {
    // 45 dB is the practical floor for distributed-vs-baseline equivalence.
    // §5.1 names 50 dB for distributed-vs-in-process per-render comparison,
    // but baseline jitter (in-process drifts ~2 dB against its own committed
    // baseline) puts 50 dB out of reach for the harness's frozen-file
    // comparison.
    expect(DISTRIBUTED_SIMULATED_MIN_PSNR_DB).toBe(45);
  });
});
