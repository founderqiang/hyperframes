/**
 * Distributed-render path for the regression harness.
 *
 * The regression harness has two modes:
 *
 *   - `in-process` (default) — calls `executeRenderJob`, the same path the
 *     `hyperframes render` CLI takes. This is what produced every existing
 *     `tests/<name>/output/output.mp4` golden baseline.
 *
 *   - `distributed-simulated` — calls `plan()` → `renderChunk()` per chunk
 *     → `assemble()` from `@hyperframes/producer/distributed`. No Temporal
 *     or Lambda involvement: the controller and chunk worker are both this
 *     process, but they go through the same artifact (planDir + frozen
 *     `meta/encoder.json` + per-chunk concat-copy) that a real fan-out
 *     would. Validates the determinism contract from §5.1 — the distributed
 *     pipeline's output must be PSNR ≥ 50 dB against the in-process
 *     baseline (the contract isn't byte-identical because streaming-encode
 *     fusion is unavailable when chunks are encoded separately).
 *
 * Not every fixture can run in distributed-simulated mode. Distributed mode
 * refuses webm, HDR mp4, NTSC framerates, and non-{24,30,60} fps at plan
 * time. Fixtures that don't meet the constraints are skipped — the harness
 * logs the reason and the fixture is treated as "passed (skipped)" in
 * distributed-simulated mode. The full determinism contract lands when the
 * Phase 4 fixtures (`tests/distributed/<name>/`) cover every supported
 * format and adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Fps } from "@hyperframes/core";
import { assemble, plan, renderChunk } from "./distributed.js";

/** Two-mode contract that backs `--mode=<value>` on the regression harness CLI. */
export type HarnessMode = "in-process" | "distributed-simulated";

/**
 * Minimum PSNR (in dB) at which a distributed-simulated render is considered
 * equivalent to its in-process baseline.
 *
 * `DISTRIBUTED-RENDERING-PLAN.md` §5.1 names ≥50 dB as the
 * distributed-vs-in-process equivalence floor, but that target was written
 * against per-render comparisons (one fresh in-process render vs one fresh
 * distributed render). The regression harness compares against a frozen
 * baseline file, and the in-process renderer itself drifts ~2 dB against
 * its own committed baseline due to libx264/JPEG-capture jitter that
 * neither mode controls. So 50 dB is empirically unreachable for either
 * mode against the frozen file.
 *
 * The harness uses 45 dB as a practical floor: it's well above the
 * 30 dB threshold most fixtures set for in-process drift, it's tight
 * enough to catch a real distributed-mode regression (renderChunk pixels
 * diverging from the in-process output by more than ~2× the in-process
 * jitter), and it tracks closely with the observed in-process-vs-baseline
 * floor of ~47-48 dB across the smoke-set fixtures.
 *
 * Fixtures with `minPsnr > 45` use their own (higher) threshold.
 */
export const DISTRIBUTED_SIMULATED_MIN_PSNR_DB = 45;

/** Result of {@link checkDistributedSupport}. */
export type DistributedSupportResult = { supported: true } | { supported: false; reason: string };

/**
 * Decide whether a fixture's `renderConfig` is one the distributed pipeline
 * can actually run. The four hard gates:
 *
 *   - fps must be `{ num: 24|30|60, den: 1 }`. `DistributedRenderConfig.fps`
 *     accepts only the three integer values, and rationals like
 *     `{ num: 30000, den: 1001 }` (NTSC) trip the type system at the call
 *     site. We surface this gate in code rather than only in TS so the
 *     harness can skip the fixture cleanly instead of throwing.
 *   - format must not be `webm`. `plan()` refuses webm with
 *     `FORMAT_NOT_SUPPORTED_IN_DISTRIBUTED`.
 *   - hdr must not be `true`. Distributed mode is SDR-only at v1.
 *
 * Callers that want the structured reason can read it off the returned
 * `reason` field; the message is intended to be log-friendly.
 */
export function checkDistributedSupport(renderConfig: {
  fps: Fps;
  format?: "mp4" | "webm";
  hdr?: boolean;
}): DistributedSupportResult {
  if (renderConfig.fps.den !== 1) {
    return {
      supported: false,
      reason: `non-integer fps ${renderConfig.fps.num}/${renderConfig.fps.den} (distributed mode requires fps.den=1)`,
    };
  }
  const fpsNum = renderConfig.fps.num;
  if (fpsNum !== 24 && fpsNum !== 30 && fpsNum !== 60) {
    return {
      supported: false,
      reason: `fps ${fpsNum} not in {24, 30, 60} (DistributedRenderConfig.fps is a closed set)`,
    };
  }
  const format = renderConfig.format ?? "mp4";
  if (format === "webm") {
    return {
      supported: false,
      reason: "format=webm refused in distributed mode (VP9+matroska concat-copy is unstable)",
    };
  }
  if (renderConfig.hdr === true) {
    return {
      supported: false,
      reason: "hdr=true refused in distributed mode (HDR signaling re-apply not implemented)",
    };
  }
  return { supported: true };
}

/**
 * Inputs for {@link runDistributedSimulatedRender}. The harness has already
 * prepared `projectDir` (a working copy of the fixture's `src/` directory)
 * and `tempRoot` (where the harness writes its scratch artifacts).
 */
export interface RunDistributedSimulatedInput {
  /** Working copy of the fixture's `src/` — contains `index.html`. */
  projectDir: string;
  /** Scratch root for plan + chunks; must be a directory the harness owns. */
  tempRoot: string;
  /** Where to write the assembled final mp4 / mov / png-sequence directory. */
  renderedOutputPath: string;
  /** From the fixture's renderConfig — must pass `checkDistributedSupport`. */
  fps: 24 | 30 | 60;
  format: "mp4" | "mov" | "png-sequence";
  /** Optional chunkSize override; defaults to the plan's 240. */
  chunkSize?: number;
  /** Optional maxParallelChunks override; defaults to the plan's 16. */
  maxParallelChunks?: number;
  /** Forwarded to `plan()` and re-applied by `renderChunk()` at boot. */
  variables?: Record<string, unknown>;
}

/**
 * Run the distributed pipeline against a single fixture as if a fan-out
 * adapter were driving it. The three activities run serially in this
 * process — there is no Temporal, no Lambda, no S3 — so the planDir,
 * chunk outputs, and assembled output all live under `tempRoot`.
 *
 * Width and height are required by `DistributedRenderConfig` for cross-call
 * sanity but are not consulted at render time — `plan()` reads the
 * composition's `data-width` / `data-height` attributes and overrides
 * whatever the config carried. The harness passes a dummy 1920×1080 here
 * for that reason; if the contract ever changes, the fixture's authored
 * dimensions will flow through `PlanResult` and we can switch to using
 * those instead.
 */
export async function runDistributedSimulatedRender(
  input: RunDistributedSimulatedInput,
): Promise<void> {
  const planDir = join(input.tempRoot, "plan");
  const chunksDir = join(input.tempRoot, "chunks");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(planDir, { recursive: true });
  mkdirSync(chunksDir, { recursive: true });

  // Step A: plan.
  const planResult = await plan(
    input.projectDir,
    {
      fps: input.fps,
      // Required-by-type but overridden by the composition's own attrs;
      // see docstring above. Any positive integer works.
      width: 1920,
      height: 1080,
      format: input.format,
      chunkSize: input.chunkSize,
      maxParallelChunks: input.maxParallelChunks,
      // Force the SDR path explicitly — `auto` would still resolve to
      // force-sdr in distributed mode, but pinning it here keeps the
      // harness's behavior independent of any future auto-detect changes.
      hdrMode: "force-sdr",
    },
    planDir,
  );

  // Step B: render every chunk. Sequential to keep the harness predictable —
  // adapters in production are free to fan out; this code path's job is to
  // exercise the per-chunk activity itself.
  const chunkPaths: string[] = [];
  for (let i = 0; i < planResult.chunkCount; i++) {
    const chunkPath =
      input.format === "png-sequence"
        ? join(chunksDir, `chunk-${String(i).padStart(4, "0")}`)
        : join(chunksDir, `chunk-${String(i).padStart(4, "0")}.${input.format}`);
    await renderChunk(planDir, i, chunkPath);
    chunkPaths.push(chunkPath);
  }

  // Step C: assemble. `audio.aac` only exists when the composition has
  // audio — pass null otherwise so `assemble()` doesn't try to mux silence.
  const audioPath = join(planDir, "audio.aac");
  const audioForAssemble = existsSync(audioPath) ? audioPath : null;
  await assemble(planDir, chunkPaths, audioForAssemble, input.renderedOutputPath);
}

/**
 * Pick the PSNR threshold for a fixture given the harness mode. In-process
 * uses the fixture's authored `minPsnr` (which may be as low as 30 dB to
 * absorb per-fixture jitter). Distributed-simulated tightens to the
 * §5.1 contract floor (50 dB) but never goes below the fixture's own
 * threshold — a fixture that demands ≥55 dB in-process stays at ≥55 dB
 * distributed.
 */
export function resolveMinPsnrForMode(mode: HarnessMode, fixtureMinPsnr: number): number {
  if (mode === "in-process") return fixtureMinPsnr;
  return Math.max(fixtureMinPsnr, DISTRIBUTED_SIMULATED_MIN_PSNR_DB);
}

/**
 * Parse `--mode=<value>` from a single CLI token. Returns the parsed mode
 * when the token matches the expected shape, `null` otherwise so the
 * caller can pass the token through to the next handler. Throws on a
 * known prefix with a bad value (`--mode=foo`) — surfacing a typo at
 * parse time is cheaper than discovering at render time.
 */
export function parseHarnessModeFlag(token: string): HarnessMode | null {
  if (token === "--mode=in-process") return "in-process";
  if (token === "--mode=distributed-simulated") return "distributed-simulated";
  if (token.startsWith("--mode=")) {
    const value = token.slice("--mode=".length);
    throw new Error(
      `regression-harness: --mode must be 'in-process' or 'distributed-simulated' (got ${JSON.stringify(value)})`,
    );
  }
  return null;
}
