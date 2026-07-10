import { defineCommand } from "citty";
import type { Example } from "./_examples.js";
import { parseAt } from "./layout.js";
import { c } from "../ui/colors.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { formatLayoutIssue } from "../utils/layoutAudit.js";
import { resolveProject, type ProjectDir } from "../utils/project.js";
import { withMeta } from "../utils/updateCheck.js";
import {
  DEFAULT_CHECK_OPTIONS,
  checkExitCode,
  runCheckPipeline,
  type CheckFinding,
  type CheckOptions,
  type CheckReport,
  type CheckSection,
} from "../utils/checkPipeline.js";

export const examples: Example[] = [
  ["Run the full verification gate", "hyperframes check"],
  ["Output one agent-readable envelope", "hyperframes check --json"],
  ["Persist the five audited contrast frames", "hyperframes check --snapshots"],
  ["Also fail on warnings", "hyperframes check --strict"],
];

export interface CheckCommandDependencies {
  resolveProject(dir: string | undefined): ProjectDir;
  runPipeline(project: ProjectDir, options: CheckOptions): Promise<CheckReport>;
  withMeta(value: object): object;
}

const DEFAULT_COMMAND_DEPENDENCIES: CheckCommandDependencies = {
  resolveProject,
  runPipeline: runCheckPipeline,
  withMeta,
};

export function createCheckCommand(
  dependencies: CheckCommandDependencies = DEFAULT_COMMAND_DEPENDENCIES,
) {
  return defineCommand({
    meta: {
      name: "check",
      description:
        "Run lint, runtime, layout, motion, and WCAG contrast verification in one browser session",
    },
    args: {
      dir: { type: "positional", description: "Project directory", required: false },
      json: { type: "boolean", description: "Output agent-readable JSON", default: false },
      samples: {
        type: "string",
        description: "Number of midpoint samples across the duration (default: 9)",
        default: "9",
      },
      at: {
        type: "string",
        description: "Comma-separated timestamps in seconds (e.g., --at 1.5,4,7.25)",
      },
      "at-transitions": {
        type: "boolean",
        description:
          "Also sample at every tween start/end boundary (plus segment midpoints) to catch transient overlaps at transition seams",
        default: false,
      },
      "max-transition-samples": {
        type: "string",
        description:
          "Optional cap on transition-derived samples; when it truncates, the omitted count is reported (default: unlimited)",
      },
      "max-issues": {
        type: "string",
        description: "Maximum issues to print or return after static collapse (default: 80)",
        default: "80",
      },
      "collapse-static": {
        type: "boolean",
        description: "Collapse repeated static issues across samples (default: true)",
        default: true,
      },
      tolerance: {
        type: "string",
        description: "Allowed pixel overflow before reporting an issue (default: 2)",
        default: "2",
      },
      timeout: {
        type: "string",
        description: "Ms to wait for scripts and media to settle initially (default: 3000)",
        default: "3000",
      },
      contrast: {
        type: "boolean",
        description: "Run the WCAG AA contrast pass (enabled by default)",
        default: true,
      },
      strict: {
        type: "boolean",
        description: "Exit non-zero on warnings too",
        default: false,
      },
      snapshots: {
        type: "boolean",
        description: "Save the five contrast-pass PNGs under snapshots/",
        default: false,
      },
    },
    async run({ args }) {
      const project = dependencies.resolveProject(args.dir);
      const options = parseCheckOptions(args);
      const asJson = args.json === true;
      if (!asJson) {
        console.log(`${c.accent("◆")}  Checking ${c.accent(project.name)}`);
      }

      try {
        const report = await dependencies.runPipeline(project, options);
        if (asJson) {
          console.log(JSON.stringify(dependencies.withMeta(report), null, 2));
        } else {
          printHumanReport(report);
        }
        process.exitCode = checkExitCode(report);
      } catch (error) {
        const message = normalizeErrorMessage(error);
        if (asJson) {
          console.log(
            JSON.stringify(dependencies.withMeta({ ok: false, error: message }), null, 2),
          );
        } else {
          console.error(`${c.error("✗")} Check failed: ${message}`);
        }
        process.exitCode = 1;
      }
    },
  });
}

function parseCheckOptions(args: Record<string, unknown>): CheckOptions {
  const maxTransitionSamplesRaw = parseInt(String(args["max-transition-samples"] ?? ""), 10);
  return {
    samples: positiveInteger(args.samples, DEFAULT_CHECK_OPTIONS.samples),
    at: parseAt(args.at),
    atTransitions: args["at-transitions"] === true,
    maxTransitionSamples:
      Number.isFinite(maxTransitionSamplesRaw) && maxTransitionSamplesRaw > 0
        ? maxTransitionSamplesRaw
        : undefined,
    maxIssues: positiveInteger(args["max-issues"], DEFAULT_CHECK_OPTIONS.maxIssues),
    collapseStatic: args["collapse-static"] !== false,
    tolerance: nonNegativeNumber(args.tolerance, DEFAULT_CHECK_OPTIONS.tolerance),
    timeout: Math.max(500, positiveInteger(args.timeout, DEFAULT_CHECK_OPTIONS.timeout)),
    contrast: args.contrast !== false,
    strict: args.strict === true,
    snapshots: args.snapshots === true,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function printHumanReport(report: CheckReport): void {
  printSection("Lint", report.lint);
  printSection("Runtime", report.runtime);
  printLayoutSection("Layout", report.layout);
  printSection("Motion", report.motion);
  printContrastSection(report);
  printSnapshotSection(report);
  console.log();
  const label = report.ok ? c.success("Check passed") : c.error("Check failed");
  console.log(`${report.ok ? c.success("◇") : c.error("◇")}  ${label}`);
}

function printSection(title: string, section: CheckSection): void {
  console.log();
  console.log(c.bold(title));
  if (section.findings.length === 0) {
    console.log(`  ${c.success("◇")} 0 errors, 0 warnings`);
    return;
  }
  for (const finding of section.findings) printFinding(finding);
  printCounts(section);
}

function printLayoutSection(title: string, section: CheckReport["layout"]): void {
  console.log();
  console.log(c.bold(title));
  if (section.findings.length === 0) {
    console.log(`  ${c.success("◇")} 0 issues across ${section.samples.length} sample(s)`);
  } else {
    for (const finding of section.findings) {
      const formatted = formatLayoutIssue(finding).replace(/\n/g, "\n    ");
      console.log(`  ${findingIcon(finding)} ${formatted}`);
    }
    printCounts(section);
  }
  if (section.transitionSamplesDropped > 0) {
    console.log(
      `  ${c.warn("⚠")} ${section.transitionSamplesDropped} transition sample(s) omitted`,
    );
  }
}

function printContrastSection(report: CheckReport): void {
  const section = report.contrast;
  console.log();
  console.log(c.bold("Contrast"));
  if (!section.enabled) {
    console.log(`  ${c.dim("◇")} skipped`);
    return;
  }
  if (section.findings.length === 0) {
    console.log(
      `  ${c.success("◇")} ${section.passed}/${section.checked} text checks pass WCAG AA`,
    );
    return;
  }
  for (const finding of section.findings) {
    console.log(
      `  ${c.error("✗")} ${finding.selector} ${finding.ratio}:1 (need ${finding.requiredRatio}:1, t=${finding.time}s)`,
    );
    console.log(`    ${c.dim(`Try ${finding.suggestedColor}; source ${finding.sourceFile}`)}`);
  }
  printCounts(section);
}

function printSnapshotSection(report: CheckReport): void {
  console.log();
  console.log(c.bold("Snapshots"));
  if (!report.snapshots.enabled) {
    console.log(`  ${c.dim("◇")} disabled`);
  } else {
    console.log(`  ${c.success("◇")} ${report.snapshots.files.length} PNG(s) saved`);
    for (const file of report.snapshots.files) console.log(`    ${c.dim(file)}`);
  }
}

function printFinding(finding: CheckFinding): void {
  const where = `${finding.sourceFile} ${finding.selector} t=${finding.time}s`;
  console.log(`  ${findingIcon(finding)} ${finding.code}: ${finding.message}`);
  console.log(`    ${c.dim(where)}`);
  if (finding.fixHint) console.log(`    ${c.dim(`Fix: ${finding.fixHint}`)}`);
}

function findingIcon(finding: CheckFinding): string {
  if (finding.severity === "error") return c.error("✗");
  if (finding.severity === "warning") return c.warn("⚠");
  return c.dim("ℹ");
}

function printCounts(section: CheckSection): void {
  console.log(
    `  ${c.dim(`${section.errorCount} error(s), ${section.warningCount} warning(s), ${section.infoCount} info(s)`)}`,
  );
}

export default createCheckCommand();
