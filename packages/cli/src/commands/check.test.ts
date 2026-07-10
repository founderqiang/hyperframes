import { runCommand } from "citty";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contrastRatio, parseColorRGBA } from "./contrast-bg.js";
import { createCheckCommand } from "./check.js";
import {
  DEFAULT_CHECK_OPTIONS,
  checkExitCode,
  runAuditGrid,
  runCheckPipeline,
  selectContrastTimes,
  type AnchoredLayoutIssue,
  type CheckAnchor,
  type CheckAuditDriver,
  type CheckBrowserResult,
  type CheckDependencies,
  type CheckFinding,
  type CheckOptions,
  type CheckReport,
  type ContrastAuditEntry,
  type MotionSpecResolution,
} from "../utils/checkPipeline.js";
import type { ProjectLintResult } from "../utils/lintProject.js";
import type { LayoutIssue } from "../utils/layoutAudit.js";
import type { ProjectDir } from "../utils/project.js";

const PROJECT: ProjectDir = {
  dir: "/project",
  name: "project",
  indexPath: "/project/index.html",
};
const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

function cleanLint(): ProjectLintResult {
  return {
    results: [
      {
        file: "index.html",
        result: {
          ok: true,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          findings: [],
        },
      },
    ],
    totalErrors: 0,
    totalWarnings: 0,
    totalInfos: 0,
  };
}

function lintWith(
  severity: "error" | "warning" | "info",
  code: string,
  message: string,
): ProjectLintResult {
  return {
    results: [
      {
        file: "index.html",
        result: {
          ok: severity !== "error",
          errorCount: severity === "error" ? 1 : 0,
          warningCount: severity === "warning" ? 1 : 0,
          infoCount: severity === "info" ? 1 : 0,
          findings: [{ severity, code, message }],
        },
      },
    ],
    totalErrors: severity === "error" ? 1 : 0,
    totalWarnings: severity === "warning" ? 1 : 0,
    totalInfos: severity === "info" ? 1 : 0,
  };
}

function anchor(selector: string, time: number): CheckAnchor {
  return {
    selector,
    dataAttributes: { "data-layout-name": "hero" },
    sourceFile: "compositions/scene.html",
    bbox: { x: 10, y: 20, width: 300, height: 80 },
    time,
  };
}

function layoutIssue(severity: "error" | "warning" | "info" = "error"): AnchoredLayoutIssue {
  return {
    ...anchor("#hero", 0.5),
    code: severity === "warning" ? "content_overlap" : "clipped_text",
    severity,
    text: "Hero",
    message: severity === "warning" ? "Text may overlap." : "Text is clipped.",
    rect: { left: 10, top: 20, right: 310, bottom: 100, width: 300, height: 80 },
  };
}

function contrastEntry(overrides: Partial<ContrastAuditEntry> = {}): ContrastAuditEntry {
  return {
    ...anchor("#hero", 0.5),
    text: "Body text",
    ratio: 2.5,
    wcagAA: false,
    large: false,
    fg: "rgb(110,110,110)",
    bg: "rgb(30,30,30)",
    ...overrides,
  };
}

function fakeDriver(overrides: Partial<CheckAuditDriver> = {}): CheckAuditDriver {
  return {
    initialize: vi.fn(async (_contrast: boolean) => undefined),
    getDuration: vi.fn(async () => 9),
    getTransitionBoundaries: vi.fn(async () => []),
    getCanvas: vi.fn(async () => ({ width: 1920, height: 1080 })),
    findAmbiguousSelectors: vi.fn(async (_selectors: string[]) => []),
    seek: vi.fn(async (_time: number) => undefined),
    collectLayout: vi.fn(async (_time: number, _tolerance: number) => []),
    collectMotionFrame: vi.fn(async (time: number) => ({ time, data: {}, liveness: {} })),
    anchorMotionIssues: vi.fn(async (issues: LayoutIssue[]) =>
      issues.map((issue) => ({
        ...issue,
        ...anchor(issue.selector, issue.time),
      })),
    ),
    collectContrast: vi.fn(async (_time: number) => ({ entries: [], pngBase64: PNG_BASE64 })),
    ...overrides,
  };
}

function noMotion(): MotionSpecResolution {
  return { kind: "none" };
}

function dependencies(
  driver: CheckAuditDriver,
  options: {
    lint?: ProjectLintResult;
    motion?: MotionSpecResolution;
    runtime?: CheckFinding[];
    writeSnapshot?: CheckDependencies["writeSnapshot"];
  } = {},
): { deps: CheckDependencies; runBrowserCheck: ReturnType<typeof vi.fn> } {
  const runBrowserCheck = vi.fn(
    async (
      _project: ProjectDir,
      checkOptions: CheckOptions,
      motion: MotionSpecResolution,
    ): Promise<CheckBrowserResult> => {
      const result = await runAuditGrid(driver, checkOptions, motion);
      return { ...result, runtimeFindings: options.runtime ?? [] };
    },
  );
  const deps: CheckDependencies = {
    lintProject: vi.fn(async () => options.lint ?? cleanLint()),
    resolveMotionSpec: vi.fn(() => options.motion ?? noMotion()),
    runBrowserCheck,
    writeSnapshot:
      options.writeSnapshot ??
      vi.fn((_projectDir: string, index: number, time: number, _pngBase64: string) =>
        Promise.resolve(
          `snapshots/frame-${String(index).padStart(2, "0")}-at-${time.toFixed(1)}s.png`,
        ),
      ),
  };
  return { deps, runBrowserCheck };
}

async function runScenario(
  driver: CheckAuditDriver,
  optionOverrides: Partial<CheckOptions> = {},
  dependencyOverrides: Parameters<typeof dependencies>[1] = {},
): Promise<{ report: CheckReport; deps: CheckDependencies; browser: ReturnType<typeof vi.fn> }> {
  const { deps, runBrowserCheck } = dependencies(driver, dependencyOverrides);
  const report = await runCheckPipeline(
    PROJECT,
    { ...DEFAULT_CHECK_OPTIONS, ...optionOverrides },
    deps,
  );
  return { report, deps, browser: runBrowserCheck };
}

function runtimeError(): CheckFinding {
  return {
    code: "console_error",
    severity: "error",
    message: "boom",
    ...anchor("[data-composition-id]", 0),
  };
}

describe("contrast sample selection", () => {
  it("chooses five evenly distributed grid points including both ends", () => {
    expect(selectContrastTimes([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5])).toEqual([
      0.5, 2.5, 4.5, 6.5, 8.5,
    ]);
    expect(selectContrastTimes([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("check pipeline", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("emits one clean JSON envelope with every section and exit 0", async () => {
    const { report } = await runScenario(fakeDriver());
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const command = createCheckCommand({
      resolveProject: () => PROJECT,
      runPipeline: vi.fn(async () => report),
      withMeta: (value) => ({ ...value, _meta: { version: "test" } }),
    });

    await runCommand(command, { rawArgs: ["--json"] });

    expect(report.ok).toBe(true);
    expect(checkExitCode(report)).toBe(0);
    expect(process.exitCode).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const output = log.mock.calls[0]?.[0];
    expect(typeof output).toBe("string");
    if (typeof output !== "string") throw new Error("expected JSON output");
    const envelope = JSON.parse(output);
    expect(envelope).toMatchObject({
      ok: true,
      lint: { ok: true },
      runtime: { ok: true },
      layout: { ok: true },
      motion: { ok: true },
      contrast: { ok: true },
      snapshots: { enabled: false },
      _meta: { version: "test" },
    });
  });

  it("short-circuits on lint errors without launching a browser", async () => {
    const lint = lintWith(
      "error",
      "root_missing_composition_id",
      "Root element needs data-composition-id.",
    );
    const { report, browser } = await runScenario(fakeDriver(), {}, { lint });

    expect(report.ok).toBe(false);
    expect(checkExitCode(report)).toBe(1);
    expect(report.lint.findings).toHaveLength(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("gates AA contrast failures and --no-contrast skips the pass", async () => {
    const failingContrast = vi.fn(async (time: number) => ({
      entries: time === 0.5 ? [contrastEntry()] : [],
      pngBase64: PNG_BASE64,
    }));
    const { report } = await runScenario(fakeDriver({ collectContrast: failingContrast }));
    expect(report.ok).toBe(false);
    expect(checkExitCode(report)).toBe(1);
    expect(report.contrast.errorCount).toBe(1);

    const skippedContrast = vi.fn(async () => ({
      entries: [contrastEntry()],
      pngBase64: PNG_BASE64,
    }));
    const skipped = await runScenario(fakeDriver({ collectContrast: skippedContrast }), {
      contrast: false,
    });
    expect(skipped.report.ok).toBe(true);
    expect(checkExitCode(skipped.report)).toBe(0);
    expect(skipped.report.contrast.enabled).toBe(false);
    expect(skippedContrast).not.toHaveBeenCalled();
  });

  it("includes measured colors, thresholds, and a passing palette-direction suggestion", async () => {
    const { report } = await runScenario(
      fakeDriver({
        collectContrast: vi.fn(async () => ({
          entries: [contrastEntry()],
          pngBase64: PNG_BASE64,
        })),
      }),
    );
    const finding = report.contrast.findings[0];
    expect(finding).toMatchObject({
      fg: "rgb(110,110,110)",
      bg: "rgb(30,30,30)",
      ratio: 2.5,
      requiredRatio: 4.5,
    });
    if (!finding) throw new Error("expected contrast finding");
    const suggested = parseColorRGBA(finding.suggestedColor);
    const background = parseColorRGBA(finding.bg);
    expect(suggested).not.toBeNull();
    expect(background).not.toBeNull();
    if (!suggested || !background) throw new Error("expected parseable colors");
    expect(
      contrastRatio(
        [suggested[0], suggested[1], suggested[2]],
        [background[0], background[1], background[2]],
      ),
    ).toBeGreaterThanOrEqual(finding.requiredRatio);
    expect(suggested[0]).toBeGreaterThan(110);
  });

  it("preserves a resolving selector, source file, identity, bbox, and sample time", async () => {
    const { report } = await runScenario(
      fakeDriver({ collectLayout: vi.fn(async () => [layoutIssue()]) }),
    );
    expect(report.layout.findings[0]).toMatchObject({
      selector: "#hero",
      dataAttributes: { "data-layout-name": "hero" },
      sourceFile: "compositions/scene.html",
      bbox: { x: 10, y: 20, width: 300, height: 80 },
      time: 0.5,
    });
  });

  it("reports layout and runtime errors from one browser session", async () => {
    const { report, browser } = await runScenario(
      fakeDriver({ collectLayout: vi.fn(async () => [layoutIssue()]) }),
      {},
      { runtime: [runtimeError()] },
    );
    expect(report.runtime.errorCount).toBe(1);
    expect(report.layout.errorCount).toBe(1);
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it("reports a failing appearsBy sidecar as motion_appears_late", async () => {
    const motion: MotionSpecResolution = {
      kind: "valid",
      path: "/project/index.motion.json",
      spec: { assertions: [{ kind: "appearsBy", selector: "#hero", bySec: 0.2 }] },
    };
    const driver = fakeDriver({
      getDuration: vi.fn(async () => 1),
      collectMotionFrame: vi.fn(async (time: number) => ({
        time,
        data: {
          "#hero": {
            rect: { left: 10, top: 20, right: 310, bottom: 100, width: 300, height: 80 },
            opacity: time >= 0.5 ? 1 : 0,
            visible: time >= 0.5,
          },
        },
        liveness: {},
      })),
    });
    const { report } = await runScenario(driver, {}, { motion });

    expect(report.motion.findings).toEqual([
      expect.objectContaining({
        code: "motion_appears_late",
        severity: "error",
        selector: "#hero",
      }),
    ]);
    expect(report.ok).toBe(false);
  });

  it("writes cached contrast PNGs only with --snapshots at the contrast timestamps", async () => {
    const writer = vi.fn(
      async (_projectDir: string, index: number, time: number, _pngBase64: string) =>
        `snapshots/frame-${String(index).padStart(2, "0")}-at-${time.toFixed(1)}s.png`,
    );
    const captured = fakeDriver({
      collectContrast: vi.fn(async () => ({ entries: [], pngBase64: PNG_BASE64 })),
    });
    const { report } = await runScenario(captured, { snapshots: true }, { writeSnapshot: writer });

    expect(report.snapshots.times).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
    expect(report.snapshots.files).toEqual([
      "snapshots/frame-00-at-0.5s.png",
      "snapshots/frame-01-at-2.5s.png",
      "snapshots/frame-02-at-4.5s.png",
      "snapshots/frame-03-at-6.5s.png",
      "snapshots/frame-04-at-8.5s.png",
    ]);
    expect(writer).toHaveBeenCalledTimes(5);

    const absentWriter = vi.fn(async () => "unused.png");
    await runScenario(fakeDriver(), { snapshots: false }, { writeSnapshot: absentWriter });
    expect(absentWriter).not.toHaveBeenCalled();
  });

  it("--strict flips a warnings-only result from exit 0 to exit 1", async () => {
    const warningDriver = () =>
      fakeDriver({ collectLayout: vi.fn(async () => [layoutIssue("warning")]) });
    const normal = await runScenario(warningDriver(), { strict: false });
    const strict = await runScenario(warningDriver(), { strict: true });

    expect(checkExitCode(normal.report)).toBe(0);
    expect(checkExitCode(strict.report)).toBe(1);
  });

  it("fails clearly without samples when no timeline duration is available, without hanging", async () => {
    const driver = fakeDriver({ getDuration: vi.fn(async () => 0) });
    await expect(runAuditGrid(driver, DEFAULT_CHECK_OPTIONS, noMotion())).rejects.toThrow(
      "Could not determine composition duration — no layout samples run",
    );

    const { report, browser } = await runScenario(driver);
    expect(browser).toHaveBeenCalledTimes(1);
    expect(report.runtime.findings[0]?.message).toContain(
      "Could not determine composition duration — no layout samples run",
    );
    expect(checkExitCode(report)).toBe(1);
  });
});

describe("contrast candidate round-trip", () => {
  it("passes the browser script's raw candidates back to finish, never the normalized copies", () => {
    const source = readFileSync(new URL("../utils/checkBrowser.ts", import.meta.url), "utf8");

    // __contrastAuditFinish samples pixels via the page script's own bbox
    // shape ({x, y, w, h}); sending the Node-normalized candidate
    // ({width, height}) makes every sample rect NaN and the audit silently
    // reports zero checked elements. The raw object must round-trip verbatim.
    expect(source).toMatch(/prepared\.map\(\(entry\) => entry\.raw\)/);
    expect(source).toMatch(/raw: unknown;/);
    expect(source).not.toMatch(/prepared\.map\(\(entry\) => entry\.candidate\)/);
  });
});
