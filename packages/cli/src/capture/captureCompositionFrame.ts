import { spawn } from "node:child_process";
import type { Browser, Page } from "puppeteer-core";
import { c } from "../ui/colors.js";
import { resolveCompositionViewportFromHtml } from "../utils/compositionViewport.js";

const SHADER_TRANSITIONS_TIMEOUT_MS = 90_000;
const CAPTURE_SETTLE_MS = 1500;
const PREFERRED_SEEK_TARGET_WAIT_MS = 500;

export interface SeekCompositionTimelineOptions {
  fallbackToBridgeAndTimelines?: boolean;
  waitForPreferredSeekTargetMs?: number;
  animationFrameSettle?: "race" | "double" | "none";
  waitForFontsMs?: number;
  settleMs?: number;
}

type CompositionPageFunction =
  | string
  | (() => unknown)
  | ((value: number) => unknown)
  | ((value: number, fallbackToBridgeAndTimelines: boolean) => unknown);

export interface CompositionEvaluationPage {
  evaluate(
    pageFunction: CompositionPageFunction,
    value?: number,
    fallbackToBridgeAndTimelines?: boolean,
  ): Promise<unknown>;
}

export interface CompositionSeekPage extends CompositionEvaluationPage {
  waitForFunction?(pageFunction: () => boolean, options: { timeout: number }): Promise<unknown>;
}

export interface SettledCompositionPage {
  browser: Browser;
  page: Page;
  // True when the runtime never signaled __renderReady within the timeout — the
  // capture proceeds anyway (possibly mid-animation), so callers can surface it.
  renderReadyTimedOut: boolean;
}

export interface OpenSettledCompositionPageOptions {
  renderReadyTimeoutMs: number;
  renderReadyWarningSuffix: string;
}

export interface FfmpegRunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

export function resolveCliChromeGpuMode(
  envMode = process.env.PRODUCER_BROWSER_GPU_MODE,
): "software" | "hardware" {
  return envMode === "software" ? "software" : "hardware";
}

function compositionRuntimeReadyInBrowser(): boolean {
  return Boolean(Reflect.get(window, "__renderReady"));
}

function shaderTransitionsReadyInBrowser(): boolean {
  function shaderTransitionRegistryReady(): boolean | undefined {
    const hf = Reflect.get(window, "__hf");
    if (typeof hf !== "object" || hf === null) return undefined;

    const shaderTransitions = Reflect.get(hf, "shaderTransitions");
    if (typeof shaderTransitions !== "object" || shaderTransitions === null) return undefined;

    for (const key of Object.keys(shaderTransitions)) {
      const entry = Reflect.get(shaderTransitions, key);
      if (typeof entry !== "object" || entry === null) return false;
      if (Reflect.get(entry, "ready") !== true) return false;
    }
    return true;
  }

  function shaderLoadingOverlayReady(): boolean {
    const overlay = document.querySelector("[data-hyper-shader-loading]");
    if (!overlay) return true;
    if (!(overlay instanceof HTMLElement)) return true;
    return window.getComputedStyle(overlay).display === "none";
  }

  return shaderTransitionRegistryReady() ?? shaderLoadingOverlayReady();
}

async function waitForCompositionSettle(
  page: Page,
  options: OpenSettledCompositionPageOptions,
): Promise<boolean> {
  const runtimeReady = await page
    .waitForFunction(compositionRuntimeReadyInBrowser, { timeout: options.renderReadyTimeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!runtimeReady) {
    console.warn(
      `\n   ${c.warn("⚠")} Runtime did not become render-ready within ${options.renderReadyTimeoutMs}ms — ${options.renderReadyWarningSuffix}`,
    );
  }

  await page
    .waitForFunction(shaderTransitionsReadyInBrowser, {
      timeout: SHADER_TRANSITIONS_TIMEOUT_MS,
    })
    .catch(() => {
      console.warn(`   ${c.warn("⚠")} Shader transitions did not finish pre-rendering`);
    });

  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await new Promise((resolveSettle) => setTimeout(resolveSettle, CAPTURE_SETTLE_MS));
  return runtimeReady;
}

export async function openSettledCompositionPage(
  html: string,
  url: string,
  options: OpenSettledCompositionPageOptions,
): Promise<SettledCompositionPage> {
  const viewport = resolveCompositionViewportFromHtml(html);
  const { ensureBrowser } = await import("../browser/manager.js");
  const browser = await ensureBrowser();
  const puppeteer = await import("puppeteer-core");
  const { buildChromeArgs } = await import("@hyperframes/engine");

  let chromeBrowser: Browser | undefined;
  try {
    chromeBrowser = await puppeteer.default.launch({
      headless: true,
      executablePath: browser.executablePath,
      args: buildChromeArgs({ ...viewport, captureMode: "screenshot" }),
    });

    const page = await chromeBrowser.newPage();
    await page.setViewport(viewport);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    const renderReadyTimedOut = !(await waitForCompositionSettle(page, options));
    return { browser: chromeBrowser, page, renderReadyTimedOut };
  } catch (err) {
    await chromeBrowser?.close().catch(() => {});
    throw err;
  }
}

export async function seekCompositionTimeline(
  page: CompositionSeekPage,
  timeSeconds: number,
  options: SeekCompositionTimelineOptions = {},
): Promise<void> {
  if (options.waitForPreferredSeekTargetMs !== undefined) {
    await waitForPreferredSeekTarget(page, options.waitForPreferredSeekTargetMs);
  }

  await page.evaluate(
    // Serialized into the page; the seek-target cascade must stay one function.
    // fallow-ignore-next-line complexity
    (t: number, fallbackToBridgeAndTimelines: boolean) => {
      const getProperty = (target: unknown, key: string): unknown => {
        if ((typeof target !== "object" || target === null) && typeof target !== "function") {
          return undefined;
        }
        return Reflect.get(target, key);
      };
      const call = (fn: unknown, receiver: unknown, args: unknown[]): boolean => {
        if (typeof fn !== "function") return false;
        Reflect.apply(fn, receiver, args);
        return true;
      };

      const player = Reflect.get(window, "__player");
      if (!player && !fallbackToBridgeAndTimelines) return;

      const safe = Math.max(0, Number(t) || 0);
      const renderSeek = getProperty(player, "renderSeek");
      const playerSeek = getProperty(player, "seek");
      const hf = Reflect.get(window, "__hf");
      const bridgeSeek = getProperty(hf, "seek");

      // Prefer renderSeek because it also runs the runtime's data-start/data-duration
      // visibility sync; raw timeline seeks leave off-window clips visible to audits.
      if (call(renderSeek, player, [safe])) {
        // Preferred runtime target handled the seek.
      } else if (fallbackToBridgeAndTimelines && call(bridgeSeek, hf, [safe])) {
        // Producer bridge handled the seek.
      } else if (call(playerSeek, player, [safe])) {
        // Legacy player target handled the seek.
      } else if (fallbackToBridgeAndTimelines) {
        const timelines = Reflect.get(window, "__timelines");
        if (typeof timelines === "object" && timelines !== null) {
          for (const key of Object.keys(timelines)) {
            const timeline = Reflect.get(timelines, key);
            call(getProperty(timeline, "pause"), timeline, []);
            call(getProperty(timeline, "seek"), timeline, [safe]);
          }
        }
      }

      const gsap = Reflect.get(window, "gsap");
      const ticker = getProperty(gsap, "ticker");
      call(getProperty(ticker, "tick"), ticker, []);
    },
    timeSeconds,
    options.fallbackToBridgeAndTimelines === true,
  );

  const animationFrameSettle = options.animationFrameSettle ?? "race";
  if (animationFrameSettle === "race") {
    await page.evaluate(`new Promise(function(r) {
      var settled = false;
      function finish() { if (settled) return; settled = true; r(); }
      window.setTimeout(finish, 100);
      requestAnimationFrame(function() { requestAnimationFrame(finish); });
    })`);
  } else if (animationFrameSettle === "double") {
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
        ),
    );
  }

  if (options.waitForFontsMs !== undefined) {
    await waitForCompositionFonts(page, options.waitForFontsMs);
  }
  if (options.settleMs !== undefined) {
    const settleMs = Math.max(0, options.settleMs);
    await new Promise((resolveSettle) => setTimeout(resolveSettle, settleMs));
  }
}

export async function waitForPreferredSeekTarget(
  page: Pick<CompositionSeekPage, "waitForFunction">,
  timeoutMs = PREFERRED_SEEK_TARGET_WAIT_MS,
): Promise<void> {
  if (!page.waitForFunction) return;
  try {
    await page.waitForFunction(
      () => {
        const player = Reflect.get(window, "__player");
        const hf = Reflect.get(window, "__hf");
        const renderSeek =
          typeof player === "object" && player !== null
            ? Reflect.get(player, "renderSeek")
            : undefined;
        const bridgeSeek =
          typeof hf === "object" && hf !== null ? Reflect.get(hf, "seek") : undefined;
        return typeof renderSeek === "function" || typeof bridgeSeek === "function";
      },
      { timeout: timeoutMs },
    );
  } catch {
    // Legacy/static pages may only expose raw timelines; keep that fallback available.
  }
}

export async function waitForCompositionFonts(
  page: CompositionEvaluationPage,
  timeoutMs: number,
): Promise<void> {
  await page
    .evaluate((ms: number) => {
      const fonts = Reflect.get(document, "fonts");
      if (typeof fonts !== "object" || fonts === null) return Promise.resolve();
      const ready = Reflect.get(fonts, "ready");
      if (!ready) return Promise.resolve();
      return Promise.race([
        Promise.resolve(ready).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
      ]);
    }, timeoutMs)
    .catch(() => {});
}

export async function runFfmpegOnce(
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<FfmpegRunResult> {
  return await new Promise((resolvePromise) => {
    const ff = spawn(ffmpegPath, args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ff.kill("SIGTERM");
    }, timeoutMs);

    ff.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    ff.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr, timedOut });
    });
    ff.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stderr: "ffmpeg spawn failed", timedOut });
    });
  });
}
