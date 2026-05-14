/**
 * Browser Manager
 *
 * Manages Puppeteer browser lifecycle: Chrome executable resolution,
 * launch args, pooled browser acquisition/release.
 */

import type { Browser, PuppeteerNode } from "puppeteer-core";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_CONFIG, type EngineConfig } from "../config.js";

let _puppeteer: PuppeteerNode | undefined;

async function getPuppeteer(): Promise<PuppeteerNode> {
  if (_puppeteer) return _puppeteer;
  try {
    const mod = await import("puppeteer" as string);
    _puppeteer = mod.default;
  } catch {
    const mod = await import("puppeteer-core");
    _puppeteer = mod.default;
  }
  if (!_puppeteer) throw new Error("Neither puppeteer nor puppeteer-core found");
  return _puppeteer;
}

// "beginframe" = atomic compositor control via HeadlessExperimental.beginFrame (Linux only)
// "screenshot" = renderSeek + Page.captureScreenshot (all platforms)
export type CaptureMode = "beginframe" | "screenshot";

export interface AcquiredBrowser {
  browser: Browser;
  captureMode: CaptureMode;
}

/**
 * Resolve chrome-headless-shell binary for deterministic BeginFrame rendering.
 * Checks config.chromePath, then PRODUCER_HEADLESS_SHELL_PATH env var,
 * then scans Puppeteer's managed cache at ~/.cache/puppeteer/chrome-headless-shell/.
 */
export function resolveHeadlessShellPath(
  config?: Partial<Pick<EngineConfig, "chromePath">>,
): string | undefined {
  if (config?.chromePath) {
    return config.chromePath;
  }
  if (process.env.PRODUCER_HEADLESS_SHELL_PATH) {
    return process.env.PRODUCER_HEADLESS_SHELL_PATH;
  }
  const baseDir = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  if (!existsSync(baseDir)) return undefined;
  try {
    const versions = readdirSync(baseDir).sort().reverse(); // newest first
    for (const version of versions) {
      const candidates = [
        join(baseDir, version, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(baseDir, version, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        join(baseDir, version, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
        join(baseDir, version, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
      ];
      for (const binary of candidates) {
        if (existsSync(binary)) return binary;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

let pooledBrowser: Browser | null = null;
let pooledBrowserRefCount = 0;
let pooledCaptureMode: CaptureMode = "screenshot";

// Preserve the producer-era export so re-export shims keep the same public API.
export const ENABLE_BROWSER_POOL = DEFAULT_CONFIG.enableBrowserPool;

// Flags only meaningful when Chrome's compositor is driven by
// HeadlessExperimental.beginFrame. If we fall back to screenshot mode they
// must be stripped — `--enable-begin-frame-control` in particular makes the
// compositor wait for frames we'll never send, producing blank screenshots.
const BEGINFRAME_ONLY_FLAGS = new Set([
  "--deterministic-mode",
  "--enable-begin-frame-control",
  "--disable-new-content-rendering-timeout",
  "--run-all-compositor-stages-before-draw",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-checker-imaging",
  "--disable-image-animation-resync",
  "--enable-surface-synchronization",
]);

function stripBeginFrameFlags(args: string[]): string[] {
  return args.filter((a) => !BEGINFRAME_ONLY_FLAGS.has(a));
}

/**
 * Probe whether the browser still speaks HeadlessExperimental.beginFrame
 * for the screenshot path the real capture loop uses.
 *
 * Recent chrome-headless-shell builds have produced two distinct failure
 * modes:
 *
 *   - chrome-headless-shell 147 dropped the method entirely; `enable`
 *     succeeds but the first beginFrame call errors out with
 *     `'HeadlessExperimental.beginFrame' wasn't found`.
 *
 *   - chrome-headless-shell 148 with `--use-angle=swiftshader` keeps the
 *     method AND the cheap `noDisplayUpdates:true` form, but the compositor
 *     silently can't raster: beginFrame with a `screenshot` parameter
 *     returns near-instantly with empty `screenshotData` and `hasDamage:false`
 *     even on frame 0 (which should always have damage). The capture loop
 *     subsequently hangs on later calls because Chrome's compositor enters
 *     a state where pending frames pile up.
 *
 * So we probe in three steps, each raced against a 2s timeout:
 *
 *   1. `enable` + one cheap `noDisplayUpdates:true` beginFrame — catches
 *     the 147-style missing-method failure.
 *   2. Navigate to a tiny inline page (`data:` URL with a colored div) so
 *     the compositor is in a non-trivial state. about:blank is
 *     special-cased in Chrome and won't trip the 148 soft failure.
 *   3. One beginFrame WITH a tiny `screenshot` request — and we assert the
 *     result actually contains screenshot bytes. A response with no
 *     `screenshotData` is treated as unsupported.
 *
 * Any failure (method missing, timeout, protocol error, empty raster) is
 * treated as unsupported. The caller then re-launches without the
 * begin-frame control flags and falls back to `Page.captureScreenshot`,
 * which works on every build we've seen — including the ones whose
 * BeginFrame path is broken.
 */
/**
 * Result of a single beginFrame probe call. `wedged` means the call
 * returned in a normal time window but with no rasterized output — Chrome
 * 148+SwiftShader does this when its compositor can't produce a raster
 * but the protocol handler is still alive.
 */
interface ProbeBeginFrameResult {
  /** True iff the call returned within the timeout. */
  returned: boolean;
  /** True iff the call returned with a non-empty screenshot. */
  rastered: boolean;
}

async function probeBeginFrameSupport(browser: Browser): Promise<boolean> {
  let page;
  try {
    page = await browser.newPage();
    const client = await page.createCDPSession();
    await client.send("HeadlessExperimental.enable");
    const probeWithTimeout = async (
      params: Parameters<typeof client.send<"HeadlessExperimental.beginFrame">>[1],
      label: string,
    ): Promise<ProbeBeginFrameResult> => {
      const call = client.send("HeadlessExperimental.beginFrame", params);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`beginFrame probe timeout (${label})`)), 2000),
      );
      const result = await Promise.race([call, timeout]);
      const screenshotData =
        result && typeof result === "object" && "screenshotData" in result
          ? (result as { screenshotData?: string }).screenshotData
          : undefined;
      return {
        returned: true,
        rastered: typeof screenshotData === "string" && screenshotData.length > 0,
      };
    };
    // Step 1: method exists. `noDisplayUpdates:true` is the cheap form
    // that pre-148 builds dropping the method would fail on.
    await probeWithTimeout({ frameTimeTicks: 0, interval: 33, noDisplayUpdates: true }, "method");
    // Step 2: method can actually produce a raster. The screenshot variant
    // is what the real capture path uses every frame.
    //
    // Chrome 148 + SwiftShader in chrome-headless-shell exhibits a soft
    // failure here: the call returns near-instantly with no
    // `screenshotData` (and `hasDamage:false` even though frame 0 should
    // always have damage). The protocol is alive, but the compositor
    // can't actually rasterize. We treat that as unsupported so the
    // caller falls back to `Page.captureScreenshot`, which works on the
    // same browser.
    //
    // Navigate to an inline page sized to match the launch viewport so
    // the compositor state lines up with what the real capture loop hits
    // after its `page.goto`. about:blank is special-cased in Chrome and
    // doesn't trip the same wedge.
    await page.setViewport({ width: 320, height: 240 }).catch(() => undefined);
    await page
      .goto(
        "data:text/html,<!doctype html><html><body style='margin:0;width:320px;height:240px;background:#222'><div style='width:320px;height:240px;background:#0af;font:40px sans-serif'>probe</div></body></html>",
        { waitUntil: "domcontentloaded", timeout: 5000 },
      )
      .catch(() => undefined);
    // Probe multiple beginFrame screenshots in succession. Chrome 148's
    // wedged-compositor case is non-deterministic: the first call may
    // return a real raster while subsequent calls return empty. The
    // real capture loop sends 60 LOCKED_WARMUP_TICKS + per-frame
    // screenshots, so any wedge that emerges after a few rapid calls
    // will hang the real render. Three back-to-back probes — each
    // raced against a 2 s timeout and asserted to carry a real raster
    // — catches every wedge mode we've observed.
    for (let i = 0; i < 3; i++) {
      const probeResult = await probeWithTimeout(
        {
          frameTimeTicks: 33 * (i + 1),
          interval: 33,
          screenshot: { format: "jpeg", quality: 1 },
        },
        `screenshot${i}`,
      );
      if (!probeResult.rastered) {
        throw new Error(
          `beginFrame probe ${i} returned without a raster — Chrome 148+SwiftShader-style soft failure`,
        );
      }
    }
    await client.detach().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    await page?.close().catch(() => {});
  }
}

/**
 * Cached *in-flight or resolved* probe Promise for `resolveBrowserGpuMode("auto", ...)`.
 *
 * Caching the Promise (rather than the resolved value) deduplicates concurrent
 * callers — the parallel coordinator runs N workers via `Promise.all`, so a
 * `--workers 4` render against a no-GPU host would otherwise fire 4
 * simultaneous probe Chromes. The first call assigns the Promise and every
 * other concurrent caller awaits the same one, paying the ~240 ms probe cost
 * exactly once per process lifetime.
 *
 * Exported for tests; production callers go through `resolveBrowserGpuMode`.
 */
export let _autoBrowserGpuModeCache: Promise<"software" | "hardware"> | undefined;

/** Test-only: reset the cached probe result. */
export function _resetAutoBrowserGpuModeCacheForTests(): void {
  _autoBrowserGpuModeCache = undefined;
}

/**
 * Resolve `browserGpuMode` to a concrete `"software" | "hardware"` answer.
 *
 * For `"software"` / `"hardware"` this is a pure pass-through. For `"auto"`
 * it launches a tiny Chrome with the platform's hardware GPU args, runs a
 * one-shot WebGL availability probe, and falls back to `"software"` if
 * hardware-mode WebGL is unavailable. The Promise is cached for the process
 * lifetime, so concurrent callers (parallel workers) share the same probe.
 *
 * Any failure (Chrome launch error, navigation timeout, missing canvas API,
 * etc.) is treated as a `"software"` fallback. The render path with
 * SwiftShader always works, so a misclassification toward software is the
 * safe failure mode; misclassifying toward hardware would error on the real
 * render.
 */
export function resolveBrowserGpuMode(
  mode: EngineConfig["browserGpuMode"],
  options: {
    chromePath?: string;
    browserTimeout?: number;
    platform?: NodeJS.Platform;
  } = {},
): Promise<"software" | "hardware"> {
  if (mode !== "auto") return Promise.resolve(mode);
  if (_autoBrowserGpuModeCache) return _autoBrowserGpuModeCache;

  _autoBrowserGpuModeCache = (async () => {
    const platform = options.platform ?? process.platform;
    const browserTimeout = options.browserTimeout ?? DEFAULT_CONFIG.browserTimeout;
    const executablePath = options.chromePath ?? resolveHeadlessShellPath({});

    const probeArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      ...getBrowserGpuArgs("hardware", platform),
    ];

    const ppt = await getPuppeteer().catch(() => null);
    if (!ppt) {
      logResolvedBrowserGpuMode("software", "puppeteer unavailable");
      return "software" as const;
    }

    let probeBrowser: Browser | undefined;
    try {
      probeBrowser = await ppt.launch({
        headless: true,
        args: probeArgs,
        defaultViewport: { width: 64, height: 64 },
        executablePath,
        timeout: browserTimeout,
      });
      const page = await probeBrowser.newPage();
      const hasWebGL = await page.evaluate(() => {
        try {
          const c = document.createElement("canvas");
          const gl =
            c.getContext("webgl") ||
            (c.getContext("experimental-webgl") as RenderingContext | null);
          return gl !== null;
        } catch {
          return false;
        }
      });
      const resolved = hasWebGL ? ("hardware" as const) : ("software" as const);
      logResolvedBrowserGpuMode(resolved, hasWebGL ? "WebGL probe succeeded" : "WebGL unavailable");
      return resolved;
    } catch (err) {
      logResolvedBrowserGpuMode(
        "software",
        `probe failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return "software" as const;
    } finally {
      await probeBrowser?.close().catch(() => {});
    }
  })();

  return _autoBrowserGpuModeCache;
}

/**
 * Single observability surface for the auto-detect outcome. Logged exactly
 * once per process (the probe runs once); without this line, a regression
 * to "always software even with a GPU present" would be invisible in
 * production. Goes to stderr to stay out of stdout pipelines.
 */
function logResolvedBrowserGpuMode(resolved: "hardware" | "software", reason: string): void {
  console.error(`[hyperframes] browserGpuMode auto → ${resolved} (${reason})`);
}

export async function acquireBrowser(
  chromeArgs: string[],
  config?: Partial<
    Pick<
      EngineConfig,
      "browserTimeout" | "protocolTimeout" | "enableBrowserPool" | "chromePath" | "forceScreenshot"
    >
  >,
): Promise<AcquiredBrowser> {
  const enablePool = config?.enableBrowserPool ?? DEFAULT_CONFIG.enableBrowserPool;

  if (enablePool && pooledBrowser) {
    pooledBrowserRefCount += 1;
    return { browser: pooledBrowser, captureMode: pooledCaptureMode };
  }

  // Config chromePath overrides env var / auto-detection.
  const headlessShell = resolveHeadlessShellPath(config);

  // BeginFrame requires chrome-headless-shell AND Linux (crashes on macOS/Windows).
  const isLinux = process.platform === "linux";
  const forceScreenshot = config?.forceScreenshot ?? DEFAULT_CONFIG.forceScreenshot;
  let captureMode: CaptureMode;
  let executablePath: string | undefined;

  if (headlessShell && isLinux && !forceScreenshot) {
    captureMode = "beginframe";
    executablePath = headlessShell;
  } else {
    // Screenshot mode with renderSeek: works on all platforms.
    captureMode = "screenshot";
    executablePath = headlessShell ?? undefined;
  }

  const ppt = await getPuppeteer();
  const browserTimeout = config?.browserTimeout ?? DEFAULT_CONFIG.browserTimeout;
  const protocolTimeout = config?.protocolTimeout ?? DEFAULT_CONFIG.protocolTimeout;
  let browser = await ppt.launch({
    headless: true,
    args: chromeArgs,
    defaultViewport: null,
    executablePath,
    timeout: browserTimeout,
    protocolTimeout,
  });

  // Probe HeadlessExperimental.beginFrame — recent chrome-headless-shell
  // builds (observed on 147) dropped the method while keeping the flags
  // valid, so `--enable-begin-frame-control` leaves the compositor waiting
  // for beginFrames the engine can no longer send. Auto-fall back to
  // screenshot mode with the appropriate flags.
  if (captureMode === "beginframe") {
    const supported = await probeBeginFrameSupport(browser).catch(() => true);
    if (!supported) {
      await browser.close().catch(() => {});
      console.warn(
        "[BrowserManager] HeadlessExperimental.beginFrame unavailable in this Chromium build; falling back to screenshot mode.",
      );
      captureMode = "screenshot";
      browser = await ppt.launch({
        headless: true,
        args: stripBeginFrameFlags(chromeArgs),
        defaultViewport: null,
        executablePath,
        timeout: browserTimeout,
        protocolTimeout,
      });
    }
  }

  if (enablePool) {
    pooledBrowser = browser;
    pooledBrowserRefCount = 1;
    pooledCaptureMode = captureMode;
  }
  return { browser, captureMode };
}

export async function releaseBrowser(
  browser: Browser,
  config?: Partial<Pick<EngineConfig, "enableBrowserPool">>,
): Promise<void> {
  const enablePool = config?.enableBrowserPool ?? DEFAULT_CONFIG.enableBrowserPool;
  if (!enablePool) {
    await browser.close().catch(() => {});
    return;
  }
  if (pooledBrowser && pooledBrowser === browser) {
    pooledBrowserRefCount = Math.max(0, pooledBrowserRefCount - 1);
    if (pooledBrowserRefCount === 0) {
      await browser.close().catch(() => {});
      pooledBrowser = null;
    }
    return;
  }
  await browser.close().catch(() => {});
}

export function forceReleaseBrowser(browser: Browser): void {
  if (pooledBrowser && pooledBrowser === browser) {
    pooledBrowserRefCount = 0;
    pooledBrowser = null;
  }
  const proc = (
    browser as unknown as {
      process?: () => { kill: (signal?: NodeJS.Signals) => boolean; killed?: boolean } | null;
    }
  ).process?.();
  if (proc && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Best-effort cleanup.
    }
  }
  try {
    browser.disconnect();
  } catch {
    // Best-effort cleanup.
  }
}

export interface BuildChromeArgsOptions {
  width: number;
  height: number;
  captureMode?: CaptureMode;
  platform?: NodeJS.Platform;
}

const CANVAS_DRAW_ELEMENT_FEATURE_FLAG = "--enable-features=CanvasDrawElement";

export function buildChromeArgs(
  options: BuildChromeArgsOptions,
  config?: Partial<Pick<EngineConfig, "browserGpuMode" | "disableGpu" | "chromePath">>,
): string[] {
  const platform = options.platform ?? process.platform;
  const gpuDisabled = config?.disableGpu ?? DEFAULT_CONFIG.disableGpu;
  const browserGpuMode = gpuDisabled
    ? "software"
    : (config?.browserGpuMode ?? DEFAULT_CONFIG.browserGpuMode);
  // Chrome flags tuned for headless rendering performance. The set below is a
  // fairly standard "headless-for-capture" configuration — similar profiles
  // appear in Puppeteer's defaults, Playwright, Remotion, and Chrome's own
  // headless-shell guidance.
  const chromeArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    CANVAS_DRAW_ELEMENT_FEATURE_FLAG,
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    ...getBrowserGpuArgs(browserGpuMode, platform),
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    `--window-size=${options.width},${options.height}`,
    // Prevent Chrome from throttling background tabs/timers — critical when the
    // page is offscreen during headless capture
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-media-suspend",
    // Reduce overhead from unused Chrome features
    "--disable-breakpad",
    "--disable-component-extensions-with-background-pages",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-print-preview",
    "--no-pings",
    "--no-zygote",
    // Memory
    "--force-gpu-mem-available-mb=4096",
    "--disk-cache-size=268435456",
    // Disable features that add overhead
    "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,Translate,BackForwardCache,IntensiveWakeUpThrottling",
  ];

  // BeginFrame flags — only when using chrome-headless-shell on Linux
  if (options.captureMode !== "screenshot") {
    chromeArgs.push(
      "--deterministic-mode",
      "--enable-begin-frame-control",
      "--disable-new-content-rendering-timeout",
      "--run-all-compositor-stages-before-draw",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--disable-checker-imaging",
      "--disable-image-animation-resync",
      "--enable-surface-synchronization",
    );
  }

  if (gpuDisabled) {
    chromeArgs.push("--disable-gpu");
  }
  return chromeArgs;
}

function getBrowserGpuArgs(
  mode: EngineConfig["browserGpuMode"],
  platform: NodeJS.Platform,
): string[] {
  if (mode === "software") {
    // Chrome 120+ deprecated implicit SwiftShader fallback; the explicit
    // path (--use-angle=swiftshader) keeps working but Chrome emits a
    // deprecation warning unless --enable-unsafe-swiftshader is also set.
    // Despite the name, this is exactly the behaviour Chrome had before;
    // the flag exists to make CPU rasterisation an explicit opt-in rather
    // than an implicit fallback for end users on the open web.
    return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  }

  if (mode === "auto") {
    // Should not reach here — `resolveBrowserGpuMode` collapses "auto" to
    // "software" or "hardware" before args are built. Be defensive: software
    // is the always-safe fallback.
    return ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  }

  switch (platform) {
    case "darwin":
      return ["--use-gl=angle", "--use-angle=metal", "--enable-gpu-rasterization"];
    case "win32":
      return ["--use-gl=angle", "--use-angle=d3d11", "--enable-gpu-rasterization"];
    case "linux":
      return ["--use-gl=egl", "--enable-gpu-rasterization"];
    default:
      return ["--enable-gpu-rasterization"];
  }
}
