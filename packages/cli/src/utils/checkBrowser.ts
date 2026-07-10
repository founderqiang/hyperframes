import type { Page } from "puppeteer-core";
import {
  openSettledCompositionPage,
  resolveCliChromeGpuMode,
  seekCompositionTimeline,
  waitForPreferredSeekTarget,
} from "../capture/captureCompositionFrame.js";
import { shouldIgnoreRequestFailure } from "../commands/validate.js";
import { loadBrowserScript } from "../commands/layout.js";
import { normalizeErrorMessage } from "./errorMessage.js";
import { ambiguousIssue, type MotionFrame } from "./motionAudit.js";
import type { LayoutIssue, LayoutIssueCode, LayoutRect } from "./layoutAudit.js";
import { serveStaticProjectHtml } from "./staticProjectServer.js";
import type {
  AnchoredLayoutIssue,
  CheckAnchor,
  CheckAuditDriver,
  CheckBbox,
  CheckBrowserResult,
  CheckFinding,
  CheckOptions,
  CheckSeverity,
  ContrastAuditEntry,
  ContrastCapture,
  MotionSpecResolution,
  RunAuditGrid,
} from "./checkTypes.js";
import type { ProjectDir } from "./project.js";

const SEEK_OPTIONS = {
  fallbackToBridgeAndTimelines: true,
  animationFrameSettle: "double" as const,
  waitForFontsMs: 500,
  settleMs: 120,
};

interface RuntimeDraft {
  code: string;
  severity: CheckSeverity;
  message: string;
  time: number;
  url?: string;
  line?: number;
}

interface AnchorRequest {
  selector: string;
  time: number;
  bbox: CheckBbox;
}

interface ContrastCandidate {
  selector: string;
  text: string;
  fg: [number, number, number, number];
  large: boolean;
  bbox: CheckBbox;
}

interface PreparedContrast {
  // The untouched candidate object from __contrastAuditPrepare. It round-trips
  // back into __contrastAuditFinish verbatim — the browser script owns its
  // shape (e.g. bbox uses w/h, not width/height), so Node must not normalize
  // what it sends back. `candidate` is the parsed copy for Node-side reporting.
  raw: unknown;
  candidate: ContrastCandidate;
  anchor: CheckAnchor;
}

interface FinishedContrast {
  selector: string;
  text: string;
  ratio: number;
  wcagAA: boolean;
  large: boolean;
  fg: string;
  bg: string;
}

export async function runBrowserCheck(
  project: ProjectDir,
  options: CheckOptions,
  motion: MotionSpecResolution,
  runGrid: RunAuditGrid,
): Promise<CheckBrowserResult> {
  const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
  const html = await bundleToSingleHtml(project.dir);
  const server = await serveStaticProjectHtml(project.dir, html, "Failed to bind check server");
  const drafts: RuntimeDraft[] = [];
  let currentTime = 0;
  let chromeBrowser: import("puppeteer-core").Browser | undefined;

  try {
    const session = await openSettledCompositionPage(html, server.url, {
      renderReadyTimeoutMs: options.timeout,
      renderReadyWarningSuffix: "checking the current page state",
      browserGpuMode: resolveCliChromeGpuMode(),
      beforeNavigate: (page) => wireRuntimeListeners(page, drafts, () => currentTime),
    });
    chromeBrowser = session.browser;
    const page = session.page;
    await waitForPreferredSeekTarget(page, 500);

    const rootAnchor = await resolveRootAnchor(page);
    const driver = createPageDriver(page, (time) => {
      currentTime = time;
    });
    const result = await runGrid(driver, options, motion);
    return {
      ...result,
      runtimeFindings: drafts.map((draft) => runtimeFinding(draft, rootAnchor)),
    };
  } finally {
    await chromeBrowser?.close().catch(() => undefined);
    await server.close();
  }
}

function wireRuntimeListeners(page: Page, drafts: RuntimeDraft[], currentTime: () => number): void {
  page.on("console", (message) => {
    const type = message.type();
    const text = message.text();
    if (type === "error" && !text.startsWith("Failed to load resource")) {
      const location = message.location();
      drafts.push({
        code: "console_error",
        severity: "error",
        message: text,
        time: currentTime(),
        url: location.url,
        line: location.lineNumber,
      });
    } else if (type === "warn") {
      const location = message.location();
      drafts.push({
        code: "console_warning",
        severity: "warning",
        message: text,
        time: currentTime(),
        url: location.url,
        line: location.lineNumber,
      });
    }
  });
  page.on("pageerror", (error) => {
    const message = normalizeErrorMessage(error);
    if (message.includes("Unexpected token '<'") || message.includes("Unexpected token '&lt;'")) {
      return;
    }
    drafts.push({ code: "page_error", severity: "error", message, time: currentTime() });
  });
  wireNetworkListeners(page, drafts, currentTime);
}

function wireNetworkListeners(page: Page, drafts: RuntimeDraft[], currentTime: () => number): void {
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("favicon") || url.startsWith("data:")) return;
    const failure = request.failure()?.errorText;
    if (shouldIgnoreRequestFailure(url, failure, request.resourceType())) return;
    drafts.push({
      code: "request_failed",
      severity: "error",
      message: `Failed to load ${urlPath(url)}: ${failure ?? "net::ERR_FAILED"}`,
      time: currentTime(),
      url,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (url.includes("favicon")) return;
    drafts.push({
      code: "http_error",
      severity: "error",
      message: `${response.status()} loading ${urlPath(url)}`,
      time: currentTime(),
      url,
    });
  });
}

function createPageDriver(page: Page, setTime: (time: number) => void): CheckAuditDriver {
  return {
    initialize: (contrast) => injectAuditScripts(page, contrast),
    getDuration: () => getCompositionDuration(page),
    getTransitionBoundaries: () => collectTweenBoundaries(page),
    getCanvas: () =>
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    findAmbiguousSelectors: (selectors) => findAmbiguousSelectors(page, selectors),
    seek: async (time) => {
      setTime(time);
      await seekCompositionTimeline(page, time, SEEK_OPTIONS);
    },
    collectLayout: (time, tolerance) => collectLayout(page, time, tolerance),
    collectMotionFrame: (time, selectors, scopes) =>
      collectMotionFrame(page, time, selectors, scopes),
    anchorMotionIssues: (issues) => anchorLayoutIssues(page, issues),
    collectContrast: (time) => collectContrast(page, time),
  };
}

async function injectAuditScripts(page: Page, contrast: boolean): Promise<void> {
  await page.addScriptTag({ content: loadBrowserScript("layout-audit.browser.js") });
  await page.addScriptTag({ content: loadBrowserScript("motion-sample.browser.js") });
  if (contrast) {
    await page.addScriptTag({ content: loadBrowserScript("contrast-audit.browser.js") });
  }
}

async function getCompositionDuration(page: Page): Promise<number> {
  // Duration resolution is serialized into the page and must remain self-contained.
  // fallow-ignore-next-line complexity
  return page.evaluate(() => {
    const value = (target: unknown, key: string): unknown =>
      typeof target === "object" && target !== null ? Reflect.get(target, key) : undefined;
    const positive = (candidate: unknown): number | null =>
      typeof candidate === "number" && candidate > 0 ? candidate : null;
    const callDuration = (target: unknown): number | null => {
      const duration = value(target, "duration");
      if (typeof duration === "function") {
        const result = Reflect.apply(duration, target, []);
        return positive(result);
      }
      return positive(duration);
    };
    const hfDuration = positive(value(Reflect.get(window, "__hf"), "duration"));
    if (hfDuration) return hfDuration;
    const playerDuration = callDuration(Reflect.get(window, "__player"));
    if (playerDuration) return playerDuration;
    const root = document.querySelector("[data-composition-id][data-duration]");
    const authored = root ? parseFloat(root.getAttribute("data-duration") ?? "0") : 0;
    if (authored > 0) return authored;
    const timelines = Reflect.get(window, "__timelines");
    if (typeof timelines !== "object" || timelines === null) return 0;
    for (const key of Object.keys(timelines)) {
      const duration = callDuration(Reflect.get(timelines, key));
      if (duration) return duration;
    }
    return 0;
  });
}

async function collectTweenBoundaries(page: Page): Promise<number[]> {
  // GSAP getter binding and parent-time conversion form one serialized algorithm.
  // fallow-ignore-next-line complexity
  return page.evaluate(() => {
    const property = (target: unknown, key: string): unknown =>
      (typeof target === "object" && target !== null) || typeof target === "function"
        ? Reflect.get(target, key)
        : undefined;
    const numberCall = (target: unknown, key: string, fallback: number): number => {
      const method = property(target, key);
      if (typeof method !== "function") return fallback;
      const result = Reflect.apply(method, target, []);
      return typeof result === "number" ? result : fallback;
    };
    const rootTime = (root: unknown, animation: unknown, local: number): number => {
      let time = local;
      let node = animation;
      while (node && node !== root) {
        time = numberCall(node, "startTime", 0) + time / (numberCall(node, "timeScale", 1) || 1);
        node = property(node, "parent");
      }
      return time;
    };
    const timelines = Reflect.get(window, "__timelines");
    if (typeof timelines !== "object" || timelines === null) return [];
    const boundaries: number[] = [];
    for (const key of Object.keys(timelines)) {
      const timeline = Reflect.get(timelines, key);
      const getChildren = property(timeline, "getChildren");
      if (typeof getChildren !== "function") continue;
      try {
        const children = Reflect.apply(getChildren, timeline, [true, true, false]);
        if (!Array.isArray(children)) continue;
        for (const child of children) {
          const duration = numberCall(child, "duration", Number.NaN);
          if (!Number.isFinite(duration)) continue;
          boundaries.push(rootTime(timeline, child, 0), rootTime(timeline, child, duration));
        }
      } catch {
        continue;
      }
    }
    return boundaries.filter(Number.isFinite);
  });
}

async function collectLayout(
  page: Page,
  time: number,
  tolerance: number,
): Promise<AnchoredLayoutIssue[]> {
  const raw = await page.evaluate(
    (options: { time: number; tolerance: number }) => {
      const audit = Reflect.get(window, "__hyperframesLayoutAudit");
      if (typeof audit !== "function") return [];
      const result = Reflect.apply(audit, window, [options]);
      return Array.isArray(result) ? result : [];
    },
    { time, tolerance },
  );
  return anchorLayoutIssues(page, raw.flatMap(parseLayoutIssue));
}

async function findAmbiguousSelectors(
  page: Page,
  selectors: string[],
): Promise<AnchoredLayoutIssue[]> {
  const ambiguous = await page.evaluate(
    (values: string[]) =>
      values.filter((selector) => {
        try {
          return document.querySelectorAll(selector).length > 1;
        } catch {
          return false;
        }
      }),
    selectors,
  );
  return anchorLayoutIssues(page, ambiguous.map(ambiguousIssue));
}

async function collectMotionFrame(
  page: Page,
  time: number,
  selectors: string[],
  livenessScopes: string[],
): Promise<MotionFrame> {
  const raw = await page.evaluate(
    (options: { selectors: string[]; livenessScopes: string[] }) => {
      const sample = Reflect.get(window, "__hyperframesMotionSample");
      if (typeof sample !== "function") return null;
      return Reflect.apply(sample, window, [options]);
    },
    { selectors, livenessScopes },
  );
  return parseMotionFrame(raw, time, selectors, livenessScopes);
}

async function anchorLayoutIssues(
  page: Page,
  issues: LayoutIssue[],
): Promise<AnchoredLayoutIssue[]> {
  const requests = issues.map((issue) => ({
    selector: issue.selector,
    time: issue.time,
    bbox: rectToBbox(issue.rect),
  }));
  const anchors = await resolveAnchors(page, requests);
  return issues.map((issue, index) => ({
    ...issue,
    ...(anchors[index] ?? fallbackAnchor(requests[index])),
  }));
}

async function resolveAnchors(page: Page, requests: AnchorRequest[]): Promise<CheckAnchor[]> {
  if (requests.length === 0) return [];
  return page.evaluate((values: AnchorRequest[]) => {
    const root = document.querySelector("[data-composition-id]");
    return values.map((request) => {
      let element: Element | null = null;
      try {
        element = document.querySelector(request.selector);
      } catch {
        element = null;
      }
      element ??= root;
      // Clones the anchor-extraction block in prepareContrast's evaluate() below;
      // both run inside separate serialized browser closures and can't share a
      // Node-side helper.
      // fallow-ignore-next-line code-duplication
      const dataAttributes: Record<string, string> = {};
      for (const attribute of Array.from(element?.attributes ?? [])) {
        if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
      }
      const source = element
        ?.closest("[data-composition-file]")
        ?.getAttribute("data-composition-file");
      return {
        selector: element ? request.selector : "[data-composition-id]",
        dataAttributes,
        sourceFile: source || "index.html",
        bbox: request.bbox,
        time: request.time,
      };
    });
  }, requests);
}

async function resolveRootAnchor(page: Page): Promise<CheckAnchor> {
  const anchors = await resolveAnchors(page, [
    { selector: "[data-composition-id]", time: 0, bbox: await compositionBbox(page) },
  ]);
  return anchors[0] ?? fallbackAnchor(undefined);
}

async function compositionBbox(page: Page): Promise<CheckBbox> {
  return page.evaluate(() => {
    const element = document.querySelector("[data-composition-id]");
    const rect = element?.getBoundingClientRect();
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : { x: 0, y: 0, width: 0, height: 0 };
  });
}

async function collectContrast(page: Page, time: number): Promise<ContrastCapture> {
  let prepared: PreparedContrast[] = [];
  try {
    prepared = parsePreparedContrast(await prepareContrast(page, time));
    const screenshot = await page.screenshot({ encoding: "base64", type: "png" });
    if (typeof screenshot !== "string") throw new Error("Contrast screenshot was not base64");
    const raw = await finishContrast(
      page,
      screenshot,
      time,
      prepared.map((entry) => entry.raw),
    );
    const finished = raw.flatMap(parseFinishedContrast);
    return { entries: joinContrastEntries(finished, prepared), pngBase64: screenshot };
  } finally {
    await page
      .evaluate(() => {
        const restore = Reflect.get(window, "__contrastAuditRestoreIfPending");
        if (typeof restore === "function") Reflect.apply(restore, window, []);
      })
      .catch(() => undefined);
  }
}

async function prepareContrast(page: Page, time: number): Promise<unknown[]> {
  // Candidate-to-element provenance must be captured while the prepare restore list is live.
  // fallow-ignore-next-line complexity
  return page.evaluate((sampleTime: number) => {
    const prepare = Reflect.get(window, "__contrastAuditPrepare");
    const candidates = typeof prepare === "function" ? Reflect.apply(prepare, window, []) : [];
    if (!Array.isArray(candidates)) return [];
    const restores = Reflect.get(window, "__contrastAuditRestores");
    const restoreList = Array.isArray(restores) ? restores : [];
    const escape = (value: string) =>
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value)
        : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    const selectorFor = (element: Element | null, fallback: string): string => {
      if (!element) return fallback;
      if (element.id) return `#${escape(element.id)}`;
      const parts: string[] = [];
      for (
        let current: Element | null = element;
        current && current !== document.body;
        current = current.parentElement
      ) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              (item) => item.tagName === current?.tagName,
            )
          : [];
        parts.push(
          siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag,
        );
      }
      return parts.reverse().join(" > ") || fallback;
    };
    // Part of the serialized evaluate body above; cannot delegate to Node helpers.
    // fallow-ignore-next-line complexity
    return candidates.map((candidate, index) => {
      const restore = restoreList[index];
      const candidateObject = typeof candidate === "object" && candidate !== null ? candidate : {};
      const elementValue =
        typeof restore === "object" && restore !== null ? Reflect.get(restore, "el") : null;
      const element = elementValue instanceof Element ? elementValue : null;
      const fallback = Reflect.get(candidateObject, "selector");
      const selector = selectorFor(
        element,
        typeof fallback === "string" ? fallback : "[data-composition-id]",
      );
      const dataAttributes: Record<string, string> = {};
      for (const attribute of Array.from(element?.attributes ?? [])) {
        if (attribute.name.startsWith("data-")) dataAttributes[attribute.name] = attribute.value;
      }
      const source = element
        ?.closest("[data-composition-file]")
        ?.getAttribute("data-composition-file");
      return {
        candidate: { ...candidateObject, selector },
        anchor: {
          selector,
          dataAttributes,
          sourceFile: source || "index.html",
          bbox: Reflect.get(candidateObject, "bbox"),
          time: sampleTime,
        },
      };
    });
  }, time);
}

async function finishContrast(
  page: Page,
  screenshot: string,
  time: number,
  candidates: unknown[],
): Promise<unknown[]> {
  return page.evaluate(
    async (payload: { screenshot: string; time: number; candidates: unknown[] }) => {
      const finish = Reflect.get(window, "__contrastAuditFinish");
      if (typeof finish !== "function") return [];
      const result = await Reflect.apply(finish, window, [
        payload.screenshot,
        payload.time,
        payload.candidates,
      ]);
      return Array.isArray(result) ? result : [];
    },
    { screenshot, time, candidates },
  );
}

function parsePreparedContrast(raw: unknown[]): PreparedContrast[] {
  return raw.flatMap((value) => {
    if (!isRecord(value)) return [];
    const raw = Reflect.get(value, "candidate");
    const candidate = parseContrastCandidate(raw);
    const anchor = parseAnchor(Reflect.get(value, "anchor"));
    return candidate && anchor ? [{ raw, candidate, anchor }] : [];
  });
}

function parseContrastCandidate(value: unknown): ContrastCandidate | null {
  if (!isRecord(value)) return null;
  const selector = stringValue(value, "selector");
  const text = stringValue(value, "text");
  const fg = rgbaValue(Reflect.get(value, "fg"));
  const large = booleanValue(value, "large");
  const bbox = parseBbox(Reflect.get(value, "bbox"));
  return selector && text !== null && fg && large !== null && bbox
    ? { selector, text, fg, large, bbox }
    : null;
}

function parseFinishedContrast(value: unknown): FinishedContrast[] {
  if (!isRecord(value)) return [];
  const selector = stringValue(value, "selector");
  const text = stringValue(value, "text");
  const ratio = numberValue(value, "ratio");
  const wcagAA = booleanValue(value, "wcagAA");
  const large = booleanValue(value, "large");
  const fg = stringValue(value, "fg");
  const bg = stringValue(value, "bg");
  return selector &&
    text !== null &&
    ratio !== null &&
    wcagAA !== null &&
    large !== null &&
    fg &&
    bg
    ? [{ selector, text, ratio, wcagAA, large, fg, bg }]
    : [];
}

function joinContrastEntries(
  finished: FinishedContrast[],
  prepared: PreparedContrast[],
): ContrastAuditEntry[] {
  const remaining = [...prepared];
  return finished.flatMap((entry) => {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.candidate.selector === entry.selector && candidate.candidate.text === entry.text,
    );
    const match = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    return match ? [{ ...entry, ...match.anchor }] : [];
  });
}

function parseLayoutIssue(value: unknown): LayoutIssue[] {
  if (!isRecord(value)) return [];
  const code = layoutCodeValue(Reflect.get(value, "code"));
  const severity = severityValue(Reflect.get(value, "severity"));
  const time = numberValue(value, "time");
  const selector = stringValue(value, "selector");
  const message = stringValue(value, "message");
  const rect = parseRect(Reflect.get(value, "rect"));
  if (!code || !severity || time === null || !selector || !message || !rect) return [];
  const issue: LayoutIssue = { code, severity, time, selector, message, rect };
  assignOptionalLayoutFields(issue, value);
  return [issue];
}

function assignOptionalLayoutFields(issue: LayoutIssue, value: Record<string, unknown>): void {
  assignOptionalString(issue, value, "containerSelector");
  assignOptionalString(issue, value, "text");
  assignOptionalString(issue, value, "fixHint");
  const containerRect = parseRect(Reflect.get(value, "containerRect"));
  if (containerRect) issue.containerRect = containerRect;
  const overflow = parseOverflow(Reflect.get(value, "overflow"));
  if (overflow) issue.overflow = overflow;
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = Reflect.get(value, key);
  return isRecord(field) ? field : null;
}

function parseMotionFrame(
  value: unknown,
  time: number,
  selectors: string[],
  scopes: string[],
): MotionFrame {
  const rawData = recordField(value, "data");
  const rawLiveness = recordField(value, "liveness");
  const data: MotionFrame["data"] = {};
  for (const selector of selectors) {
    data[selector] = rawData ? parseFrameSample(Reflect.get(rawData, selector)) : null;
  }
  const liveness: Record<string, string> = {};
  for (const scope of scopes) {
    const signature = rawLiveness ? Reflect.get(rawLiveness, scope) : "";
    liveness[scope] = typeof signature === "string" ? signature : "";
  }
  return { time, data, liveness };
}

function parseFrameSample(value: unknown): MotionFrame["data"][string] {
  if (!isRecord(value)) return null;
  const rect = parseRect(Reflect.get(value, "rect"));
  const opacity = numberValue(value, "opacity");
  const visible = booleanValue(value, "visible");
  return rect && opacity !== null && visible !== null ? { rect, opacity, visible } : null;
}

function parseAnchor(value: unknown): CheckAnchor | null {
  if (!isRecord(value)) return null;
  const selector = stringValue(value, "selector");
  const sourceFile = stringValue(value, "sourceFile");
  const time = numberValue(value, "time");
  const bbox = parseBbox(Reflect.get(value, "bbox"));
  const dataAttributes = stringRecord(Reflect.get(value, "dataAttributes"));
  return selector && sourceFile && time !== null && bbox && dataAttributes
    ? { selector, sourceFile, time, bbox, dataAttributes }
    : null;
}

function runtimeFinding(draft: RuntimeDraft, root: CheckAnchor): CheckFinding {
  return {
    code: draft.code,
    severity: draft.severity,
    message: draft.message,
    selector: root.selector,
    dataAttributes: root.dataAttributes,
    sourceFile: root.sourceFile,
    bbox: root.bbox,
    time: draft.time,
    url: draft.url,
    line: draft.line,
  };
}

function fallbackAnchor(request: AnchorRequest | undefined): CheckAnchor {
  return {
    selector: request?.selector ?? "[data-composition-id]",
    dataAttributes: {},
    sourceFile: "index.html",
    bbox: request?.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
    time: request?.time ?? 0,
  };
}

function rectToBbox(rect: LayoutRect): CheckBbox {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function parseBbox(value: unknown): CheckBbox | null {
  if (!isRecord(value)) return null;
  const x = numberValue(value, "x");
  const y = numberValue(value, "y");
  const width = numberValue(value, "width") ?? numberValue(value, "w");
  const height = numberValue(value, "height") ?? numberValue(value, "h");
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

function parseRect(value: unknown): LayoutRect | null {
  if (!isRecord(value)) return null;
  const left = numberValue(value, "left");
  const top = numberValue(value, "top");
  const right = numberValue(value, "right");
  const bottom = numberValue(value, "bottom");
  const width = numberValue(value, "width");
  const height = numberValue(value, "height");
  return left !== null &&
    top !== null &&
    right !== null &&
    bottom !== null &&
    width !== null &&
    height !== null
    ? { left, top, right, bottom, width, height }
    : null;
}

function parseOverflow(value: unknown): LayoutIssue["overflow"] | null {
  if (!isRecord(value)) return null;
  const overflow: LayoutIssue["overflow"] = {};
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const amount = numberValue(value, side);
    if (amount !== null) overflow[side] = amount;
  }
  return Object.keys(overflow).length > 0 ? overflow : null;
}

const LAYOUT_ISSUE_CODES: readonly LayoutIssueCode[] = [
  "text_box_overflow",
  "clipped_text",
  "canvas_overflow",
  "container_overflow",
  "content_overlap",
  "text_occluded",
  "motion_appears_late",
  "motion_out_of_order",
  "motion_off_frame",
  "motion_frozen",
  "motion_selector_missing",
  "motion_selector_ambiguous",
];

function layoutCodeValue(value: unknown): LayoutIssueCode | null {
  return LAYOUT_ISSUE_CODES.find((code) => code === value) ?? null;
}

function severityValue(value: unknown): CheckSeverity | null {
  return value === "error" || value === "warning" || value === "info" ? value : null;
}

function rgbaValue(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [red, green, blue, alpha] = value;
  return [red, green, blue, alpha].every((channel) => typeof channel === "number")
    ? [red, green, blue, alpha]
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const record: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const entry = Reflect.get(value, key);
    if (typeof entry !== "string") return null;
    record[key] = entry;
  }
  return record;
}

function assignOptionalString(
  issue: LayoutIssue,
  source: Record<string, unknown>,
  key: "containerSelector" | "text" | "fixHint",
): void {
  const value = stringValue(source, key);
  if (value !== null) issue[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: Record<string, unknown>, key: string): string | null {
  const entry = Reflect.get(value, key);
  return typeof entry === "string" ? entry : null;
}

function numberValue(value: Record<string, unknown>, key: string): number | null {
  const entry = Reflect.get(value, key);
  return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
}

function booleanValue(value: Record<string, unknown>, key: string): boolean | null {
  const entry = Reflect.get(value, key);
  return typeof entry === "boolean" ? entry : null;
}

function urlPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
  } catch {
    return url;
  }
}
