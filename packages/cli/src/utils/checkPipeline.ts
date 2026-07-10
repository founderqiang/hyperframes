import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProjectDir } from "./project.js";
import { lintProject, shouldBlockRender, type ProjectLintResult } from "./lintProject.js";
import {
  buildLayoutSampleTimes,
  buildTransitionSampleTimes,
  collapseStaticLayoutIssues,
  dedupeLayoutIssues,
  limitLayoutIssues,
  mergeSampleTimes,
  type LayoutIssue,
  type LayoutRect,
} from "./layoutAudit.js";
import { collectSamplingTargets, evaluateMotion, type MotionFrame } from "./motionAudit.js";
import { findMotionSpec, readMotionSpec } from "./motionSpec.js";
import { normalizeErrorMessage } from "./errorMessage.js";
import {
  parseColorRGBA,
  requiredContrastRatio,
  suggestCompliantForegroundColor,
  type Rgb,
} from "../commands/contrast-bg.js";
import type {
  AnchoredLayoutIssue,
  CheckAuditDriver,
  CheckBbox,
  CheckBrowserResult,
  CheckContrastFinding,
  CheckDependencies,
  CheckFinding,
  CheckOptions,
  CheckReport,
  CheckScreenshot,
  CheckSection,
  CheckSeverity,
  ContrastAuditEntry,
  MotionSpecResolution,
} from "./checkTypes.js";

export type {
  AnchoredLayoutIssue,
  CheckAnchor,
  CheckAuditDriver,
  CheckBrowserResult,
  CheckDependencies,
  CheckFinding,
  CheckOptions,
  CheckReport,
  CheckSection,
  ContrastAuditEntry,
  MotionSpecResolution,
} from "./checkTypes.js";

const MOTION_FPS = 20;
const MOTION_MAX_SAMPLES = 300;
const ZERO_BBOX: CheckBbox = { x: 0, y: 0, width: 0, height: 0 };

export const DEFAULT_CHECK_OPTIONS: CheckOptions = {
  samples: 9,
  atTransitions: false,
  maxIssues: 80,
  collapseStatic: true,
  tolerance: 2,
  timeout: 3000,
  contrast: true,
  strict: false,
  snapshots: false,
};

/** Pick at most five evenly-strided points from the already-merged layout grid. */
export function selectContrastTimes(grid: number[]): number[] {
  if (grid.length <= 5) return [...grid];
  return Array.from({ length: 5 }, (_, index) => {
    const selected = Math.floor((index * (grid.length - 1)) / 4);
    return grid[selected] ?? grid[0] ?? 0;
  });
}

function buildMotionSampleTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const count = Math.min(MOTION_MAX_SAMPLES, Math.max(2, Math.ceil(duration * MOTION_FPS) + 1));
  const step = duration / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(index * step * 1000) / 1000);
}

interface SampleGrid {
  duration: number;
  layoutSamples: number[];
  transitionSamples: number[];
  transitionSamplesDropped: number;
  contrastSamples: number[];
}

async function buildSampleGrid(
  driver: CheckAuditDriver,
  options: CheckOptions,
): Promise<SampleGrid> {
  const duration = await driver.getDuration();
  const baseSamples = buildLayoutSampleTimes({
    duration,
    samples: options.samples,
    at: options.at,
  });
  const transitions = options.atTransitions
    ? buildTransitionSampleTimes({
        duration,
        boundaries: await driver.getTransitionBoundaries(),
        cap: options.maxTransitionSamples,
      })
    : { times: [], dropped: 0 };
  const layoutSamples = mergeSampleTimes(baseSamples, transitions.times);
  if (layoutSamples.length === 0) {
    throw new Error("Could not determine composition duration — no layout samples run");
  }
  return {
    duration,
    layoutSamples,
    transitionSamples: transitions.times,
    transitionSamplesDropped: transitions.dropped,
    contrastSamples: options.contrast ? selectContrastTimes(layoutSamples) : [],
  };
}

interface MotionPlan {
  times: number[];
  selectors: string[];
  livenessScopes: string[];
  preflightIssues: AnchoredLayoutIssue[];
}

async function planMotionSampling(
  driver: CheckAuditDriver,
  motion: MotionSpecResolution,
  duration: number,
): Promise<MotionPlan> {
  if (motion.kind !== "valid") {
    return { times: [], selectors: [], livenessScopes: [], preflightIssues: [] };
  }
  const targets = collectSamplingTargets(motion.spec.assertions);
  const preflightIssues = await driver.findAmbiguousSelectors(targets.selectors);
  const times =
    preflightIssues.length === 0 ? buildMotionSampleTimes(motion.spec.duration ?? duration) : [];
  return { times, ...targets, preflightIssues };
}

interface GridSamples {
  layoutIssues: AnchoredLayoutIssue[];
  motionFrames: MotionFrame[];
  contrastEntries: ContrastAuditEntry[];
  screenshots: CheckScreenshot[];
}

async function collectGridSamples(
  driver: CheckAuditDriver,
  options: CheckOptions,
  grid: SampleGrid,
  motion: MotionPlan,
): Promise<GridSamples> {
  const layoutSet = new Set(grid.layoutSamples);
  const motionSet = new Set(motion.times);
  const contrastSet = new Set(grid.contrastSamples);
  const collected: GridSamples = {
    layoutIssues: [],
    motionFrames: [],
    contrastEntries: [],
    screenshots: [],
  };
  for (const time of mergeSampleTimes(grid.layoutSamples, motion.times)) {
    await driver.seek(time);
    if (layoutSet.has(time)) {
      collected.layoutIssues.push(...(await driver.collectLayout(time, options.tolerance)));
    }
    if (motionSet.has(time)) {
      collected.motionFrames.push(
        await driver.collectMotionFrame(time, motion.selectors, motion.livenessScopes),
      );
    }
    if (contrastSet.has(time)) {
      const capture = await driver.collectContrast(time);
      collected.contrastEntries.push(...capture.entries);
      collected.screenshots.push({ time, pngBase64: capture.pngBase64 });
    }
  }
  return collected;
}

export async function runAuditGrid(
  driver: CheckAuditDriver,
  options: CheckOptions,
  motion: MotionSpecResolution,
): Promise<CheckBrowserResult> {
  await driver.initialize(options.contrast);
  const grid = await buildSampleGrid(driver, options);
  const plan = await planMotionSampling(driver, motion, grid.duration);
  const collected = await collectGridSamples(driver, options, grid, plan);

  let motionIssues = plan.preflightIssues;
  if (motion.kind === "valid" && motionIssues.length === 0 && collected.motionFrames.length > 0) {
    const evaluated = evaluateMotion(
      collected.motionFrames,
      motion.spec.assertions,
      await driver.getCanvas(),
    );
    motionIssues = await driver.anchorMotionIssues(evaluated);
  }
  const contrast = buildContrastResults(collected.contrastEntries);
  return {
    duration: grid.duration,
    layoutSamples: grid.layoutSamples,
    transitionSamples: grid.transitionSamples,
    transitionSamplesDropped: grid.transitionSamplesDropped,
    runtimeFindings: [],
    layoutIssues: collected.layoutIssues,
    motionIssues,
    motionSampleCount: collected.motionFrames.length,
    contrastSamples: grid.contrastSamples,
    contrastFindings: contrast.findings,
    contrastChecked: collected.contrastEntries.length,
    contrastPassed: contrast.passed,
    screenshots: collected.screenshots,
  };
}

export async function runCheckPipeline(
  project: ProjectDir,
  options: CheckOptions,
  dependencies: CheckDependencies = DEFAULT_DEPENDENCIES,
): Promise<CheckReport> {
  let lintResult: ProjectLintResult;
  try {
    lintResult = await dependencies.lintProject(project.dir);
  } catch (error) {
    return failureReport(options, runtimeFailure(error));
  }

  const lint = buildLintSection(lintResult);
  if (shouldBlockRender(true, false, lintResult.totalErrors, lintResult.totalWarnings)) {
    return buildReport(options, lint, emptyBrowserResult(), { kind: "none" }, [], []);
  }

  const motion = dependencies.resolveMotionSpec(project.dir);
  if (motion.kind === "invalid") {
    const finding = findingAtRoot(
      "motion_spec_invalid",
      "error",
      motion.message,
      relative(project.dir, motion.path) || "index.motion.json",
    );
    return buildReport(options, lint, emptyBrowserResult(), motion, [finding], []);
  }

  let browser: CheckBrowserResult;
  try {
    browser = await dependencies.runBrowserCheck(project, options, motion);
  } catch (error) {
    browser = emptyBrowserResult();
    browser.runtimeFindings.push(runtimeFailure(error));
  }

  const snapshotFiles: string[] = [];
  if (options.snapshots) {
    for (let index = 0; index < browser.screenshots.length; index += 1) {
      const shot = browser.screenshots[index];
      if (!shot) continue;
      try {
        snapshotFiles.push(
          await dependencies.writeSnapshot(project.dir, index, shot.time, shot.pngBase64),
        );
      } catch (error) {
        browser.runtimeFindings.push(runtimeFailure(error, "snapshot_write_failed"));
      }
    }
  }
  return buildReport(options, lint, browser, motion, [], snapshotFiles);
}

export function checkExitCode(report: CheckReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

function buildContrastResults(entries: ContrastAuditEntry[]): {
  findings: CheckContrastFinding[];
  passed: number;
} {
  const findings: CheckContrastFinding[] = [];
  let passed = 0;
  for (const entry of entries) {
    if (entry.wcagAA) {
      passed += 1;
      continue;
    }
    const requiredRatio = requiredContrastRatio(entry.large);
    findings.push({
      code: "contrast_aa_failure",
      severity: "error",
      message: `Contrast is ${entry.ratio}:1; WCAG AA requires ${requiredRatio}:1.`,
      text: entry.text,
      fg: entry.fg,
      bg: entry.bg,
      ratio: entry.ratio,
      requiredRatio,
      suggestedColor: suggestedColor(entry.fg, entry.bg, requiredRatio),
      large: entry.large,
      selector: entry.selector,
      dataAttributes: entry.dataAttributes,
      sourceFile: entry.sourceFile,
      bbox: entry.bbox,
      time: entry.time,
    });
  }
  return { findings, passed };
}

function suggestedColor(fg: string, bg: string, requiredRatio: number): string {
  const foreground = parseColorRGBA(fg);
  const background = parseColorRGBA(bg);
  if (!foreground || !background) return fg;
  const fgRgb: Rgb = [foreground[0], foreground[1], foreground[2]];
  const bgRgb: Rgb = [background[0], background[1], background[2]];
  const suggested = suggestCompliantForegroundColor(fgRgb, bgRgb, requiredRatio);
  return `rgb(${suggested[0]},${suggested[1]},${suggested[2]})`;
}

function buildLintSection(result: ProjectLintResult): CheckReport["lint"] {
  const findings = result.results.flatMap(({ file, result: fileResult }) =>
    fileResult.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      selector:
        finding.selector ?? (finding.elementId ? `#${finding.elementId}` : "[data-composition-id]"),
      dataAttributes: {},
      sourceFile: finding.file ?? file,
      bbox: ZERO_BBOX,
      time: 0,
      fixHint: finding.fixHint,
    })),
  );
  return { ...section(findings), filesScanned: result.results.length };
}

function buildReport(
  options: CheckOptions,
  lint: CheckReport["lint"],
  browser: CheckBrowserResult,
  motion: MotionSpecResolution,
  extraMotionFindings: CheckFinding[],
  snapshotFiles: string[],
): CheckReport {
  const layout = shapeLayoutSection(browser.layoutIssues, browser, options);
  const shapedMotion = shapeLayoutFindings(browser.motionIssues, options);
  const motionFindings: CheckFinding[] = [...shapedMotion.findings, ...extraMotionFindings];
  const runtime = section(browser.runtimeFindings);
  const motionSection = section(motionFindings);
  const contrastSection = section(browser.contrastFindings);
  const warningCount =
    lint.warningCount +
    runtime.warningCount +
    layout.warningCount +
    motionSection.warningCount +
    contrastSection.warningCount;
  const errorCount =
    lint.errorCount +
    runtime.errorCount +
    layout.errorCount +
    motionSection.errorCount +
    contrastSection.errorCount;
  return {
    ok: errorCount === 0 && (!options.strict || warningCount === 0),
    strict: options.strict,
    lint,
    runtime,
    layout,
    motion: {
      ...motionSection,
      enabled: motion.kind !== "none",
      specPath: motion.kind === "none" ? undefined : motion.path,
      samples: browser.motionSampleCount,
    },
    contrast: {
      ...contrastSection,
      enabled: options.contrast,
      samples: browser.contrastSamples,
      checked: browser.contrastChecked,
      passed: browser.contrastPassed,
    },
    snapshots: {
      enabled: options.snapshots,
      files: snapshotFiles,
      times: options.snapshots ? browser.screenshots.map((shot) => shot.time) : [],
    },
  };
}

function shapeLayoutSection(
  issues: AnchoredLayoutIssue[],
  browser: CheckBrowserResult,
  options: CheckOptions,
): CheckReport["layout"] {
  const shaped = shapeLayoutFindings(issues, options);
  return {
    ...section(shaped.findings),
    duration: browser.duration,
    samples: browser.layoutSamples,
    transitionSamples: browser.transitionSamples,
    transitionSamplesDropped: browser.transitionSamplesDropped,
    tolerance: options.tolerance,
    totalIssueCount: shaped.totalIssueCount,
    truncated: shaped.truncated,
  };
}

function shapeLayoutFindings(
  issues: AnchoredLayoutIssue[],
  options: CheckOptions,
): { findings: AnchoredLayoutIssue[]; totalIssueCount: number; truncated: boolean } {
  const deduped = dedupeLayoutIssues(issues);
  const all = options.collapseStatic ? collapseStaticLayoutIssues(deduped) : deduped;
  const limited = limitLayoutIssues(all, options.maxIssues);
  return {
    findings: limited.issues.map(ensureAnchoredLayoutIssue),
    totalIssueCount: limited.totalIssueCount,
    truncated: limited.truncated,
  };
}

function ensureAnchoredLayoutIssue(issue: LayoutIssue): AnchoredLayoutIssue {
  const sourceFile = Reflect.get(issue, "sourceFile");
  const dataAttributes = Reflect.get(issue, "dataAttributes");
  const bbox = Reflect.get(issue, "bbox");
  if (typeof sourceFile === "string" && isStringRecord(dataAttributes) && isBbox(bbox)) {
    return { ...issue, sourceFile, dataAttributes, bbox };
  }
  return {
    ...issue,
    sourceFile: "index.html",
    dataAttributes: {},
    bbox: rectToBbox(issue.rect),
  };
}

function section<T extends CheckFinding>(findings: T[]): CheckSection<T> {
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.filter((finding) => finding.severity === "info").length;
  return { ok: errorCount === 0, errorCount, warningCount, infoCount, findings };
}

function emptyBrowserResult(): CheckBrowserResult {
  return {
    duration: 0,
    layoutSamples: [],
    transitionSamples: [],
    transitionSamplesDropped: 0,
    runtimeFindings: [],
    layoutIssues: [],
    motionIssues: [],
    motionSampleCount: 0,
    contrastSamples: [],
    contrastFindings: [],
    contrastChecked: 0,
    contrastPassed: 0,
    screenshots: [],
  };
}

function runtimeFailure(error: unknown, code = "check_runtime_failure"): CheckFinding {
  return findingAtRoot(code, "error", normalizeErrorMessage(error), "index.html");
}

function findingAtRoot(
  code: string,
  severity: CheckSeverity,
  message: string,
  sourceFile: string,
): CheckFinding {
  return {
    code,
    severity,
    message,
    selector: "[data-composition-id]",
    dataAttributes: {},
    sourceFile,
    bbox: ZERO_BBOX,
    time: 0,
  };
}

function failureReport(options: CheckOptions, finding: CheckFinding): CheckReport {
  const lint = { ...section([]), filesScanned: 0 };
  const browser = emptyBrowserResult();
  browser.runtimeFindings.push(finding);
  return buildReport(options, lint, browser, { kind: "none" }, [], []);
}

function rectToBbox(rect: LayoutRect): CheckBbox {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function isBbox(value: unknown): value is CheckBbox {
  if (typeof value !== "object" || value === null) return false;
  return ["x", "y", "width", "height"].every((key) => typeof Reflect.get(value, key) === "number");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => typeof Reflect.get(value, key) === "string");
}

function resolveMotionSpec(projectDir: string): MotionSpecResolution {
  const path = findMotionSpec(projectDir);
  if (!path) return { kind: "none" };
  const result = readMotionSpec(path);
  return result.ok
    ? { kind: "valid", path, spec: result.spec }
    : {
        kind: "invalid",
        path,
        message: `Invalid motion spec ${path}: ${result.errors.join("; ")}`,
      };
}

async function runBrowserCheck(
  project: ProjectDir,
  options: CheckOptions,
  motion: MotionSpecResolution,
): Promise<CheckBrowserResult> {
  const module = await import("./checkBrowser.js");
  // runAuditGrid is handed over as a callback so checkBrowser never imports
  // this module back (no import cycle).
  return module.runBrowserCheck(project, options, motion, runAuditGrid);
}

async function writeSnapshot(
  projectDir: string,
  index: number,
  time: number,
  pngBase64: string,
): Promise<string> {
  const snapshotDir = join(projectDir, "snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  const filename = `frame-${String(index).padStart(2, "0")}-at-${time.toFixed(1)}s.png`;
  const path = join(snapshotDir, filename);
  writeFileSync(path, Buffer.from(pngBase64, "base64"));
  return join("snapshots", filename);
}

const DEFAULT_DEPENDENCIES: CheckDependencies = {
  lintProject,
  resolveMotionSpec,
  runBrowserCheck,
  writeSnapshot,
};
