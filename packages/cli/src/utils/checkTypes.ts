import type { ProjectLintResult } from "./lintProject.js";
import type { LayoutIssue } from "./layoutAudit.js";
import type { Canvas, MotionFrame } from "./motionAudit.js";
import type { MotionSpec } from "./motionSpec.js";
import type { ProjectDir } from "./project.js";

export interface CheckOptions {
  samples: number;
  at?: number[];
  atTransitions: boolean;
  maxTransitionSamples?: number;
  maxIssues: number;
  collapseStatic: boolean;
  tolerance: number;
  timeout: number;
  contrast: boolean;
  strict: boolean;
  snapshots: boolean;
}

export type CheckSeverity = "error" | "warning" | "info";

export interface CheckBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CheckAnchor {
  selector: string;
  dataAttributes: Record<string, string>;
  sourceFile: string;
  bbox: CheckBbox;
  time: number;
}

export interface CheckFinding extends CheckAnchor {
  code: string;
  severity: CheckSeverity;
  message: string;
  text?: string;
  fixHint?: string;
  url?: string;
  line?: number;
}

export interface AnchoredLayoutIssue extends LayoutIssue, CheckAnchor {}

export interface ContrastAuditEntry extends CheckAnchor {
  text: string;
  ratio: number;
  wcagAA: boolean;
  large: boolean;
  fg: string;
  bg: string;
}

export interface CheckContrastFinding extends CheckFinding {
  fg: string;
  bg: string;
  ratio: number;
  requiredRatio: number;
  suggestedColor: string;
  large: boolean;
}

export interface ContrastCapture {
  entries: ContrastAuditEntry[];
  pngBase64: string;
}

export type MotionSpecResolution =
  | { kind: "none" }
  | { kind: "valid"; path: string; spec: MotionSpec }
  | { kind: "invalid"; path: string; message: string };

export interface CheckAuditDriver {
  initialize(contrast: boolean): Promise<void>;
  getDuration(): Promise<number>;
  getTransitionBoundaries(): Promise<number[]>;
  getCanvas(): Promise<Canvas>;
  findAmbiguousSelectors(selectors: string[]): Promise<AnchoredLayoutIssue[]>;
  seek(time: number): Promise<void>;
  collectLayout(time: number, tolerance: number): Promise<AnchoredLayoutIssue[]>;
  collectMotionFrame(
    time: number,
    selectors: string[],
    livenessScopes: string[],
  ): Promise<MotionFrame>;
  anchorMotionIssues(issues: LayoutIssue[]): Promise<AnchoredLayoutIssue[]>;
  collectContrast(time: number): Promise<ContrastCapture>;
}

export interface CheckScreenshot {
  time: number;
  pngBase64: string;
}

export interface CheckBrowserResult {
  duration: number;
  layoutSamples: number[];
  transitionSamples: number[];
  transitionSamplesDropped: number;
  runtimeFindings: CheckFinding[];
  layoutIssues: AnchoredLayoutIssue[];
  motionIssues: AnchoredLayoutIssue[];
  motionSampleCount: number;
  contrastSamples: number[];
  contrastFindings: CheckContrastFinding[];
  contrastChecked: number;
  contrastPassed: number;
  screenshots: CheckScreenshot[];
}

/** The seek-grid audit loop, injected into checkBrowser so it never imports checkPipeline back. */
export type RunAuditGrid = (
  driver: CheckAuditDriver,
  options: CheckOptions,
  motion: MotionSpecResolution,
) => Promise<CheckBrowserResult>;

export interface CheckSection<T extends CheckFinding = CheckFinding> {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  findings: T[];
}

export interface CheckReport {
  ok: boolean;
  strict: boolean;
  lint: CheckSection & { filesScanned: number };
  runtime: CheckSection;
  layout: CheckSection<AnchoredLayoutIssue> & {
    duration: number;
    samples: number[];
    transitionSamples: number[];
    transitionSamplesDropped: number;
    tolerance: number;
    totalIssueCount: number;
    truncated: boolean;
  };
  motion: CheckSection & { enabled: boolean; specPath?: string; samples: number };
  contrast: CheckSection<CheckContrastFinding> & {
    enabled: boolean;
    samples: number[];
    checked: number;
    passed: number;
  };
  snapshots: { enabled: boolean; files: string[]; times: number[] };
}

export interface CheckDependencies {
  lintProject(projectDir: string): Promise<ProjectLintResult>;
  resolveMotionSpec(projectDir: string): MotionSpecResolution;
  runBrowserCheck(
    project: ProjectDir,
    options: CheckOptions,
    motion: MotionSpecResolution,
  ): Promise<CheckBrowserResult>;
  writeSnapshot(
    projectDir: string,
    index: number,
    time: number,
    pngBase64: string,
  ): Promise<string>;
}
