import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCliChromeGpuMode,
  runFfmpegOnce,
  seekCompositionTimeline,
  type CompositionSeekPage,
} from "./captureCompositionFrame.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hf-capture-frame-test-"));
}

function fakeSeekPage() {
  const evaluate = vi.fn(
    async (
      _pageFunction: Parameters<CompositionSeekPage["evaluate"]>[0],
      _value?: number,
      _fallbackToBridgeAndTimelines?: boolean,
    ): Promise<unknown> => undefined,
  );
  const waitForFunction = vi.fn(
    async (_pageFunction: () => boolean, _options: { timeout: number }): Promise<unknown> =>
      undefined,
  );
  const page: CompositionSeekPage = { evaluate, waitForFunction };
  return { page, evaluate, waitForFunction };
}

function runBrowserSeek(evaluate: ReturnType<typeof fakeSeekPage>["evaluate"]): void {
  const seekInBrowser = evaluate.mock.calls[0]?.[0];
  if (typeof seekInBrowser !== "function") throw new Error("Expected a browser seek function");
  Reflect.apply(seekInBrowser, undefined, evaluate.mock.calls[0]?.slice(1) ?? []);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("seekCompositionTimeline", () => {
  it("keeps the existing raced double-frame settle as the default", async () => {
    const { page, evaluate, waitForFunction } = fakeSeekPage();

    await seekCompositionTimeline(page, 1.25);

    expect(waitForFunction).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenNthCalledWith(1, expect.any(Function), 1.25, false);
    expect(evaluate.mock.calls[1]?.[0]).toContain("window.setTimeout(finish, 100)");
  });

  it("prefers renderSeek so the runtime synchronizes clip visibility", async () => {
    const { page, evaluate } = fakeSeekPage();
    const renderSeek = vi.fn();
    const bridgeSeek = vi.fn();
    const playerSeek = vi.fn();
    const timelineSeek = vi.fn();
    vi.stubGlobal("window", {
      __player: { renderSeek, seek: playerSeek },
      __hf: { seek: bridgeSeek },
      __timelines: { main: { seek: timelineSeek } },
    });

    await seekCompositionTimeline(page, 2.25);
    runBrowserSeek(evaluate);

    expect(renderSeek).toHaveBeenCalledWith(2.25);
    expect(bridgeSeek).not.toHaveBeenCalled();
    expect(playerSeek).not.toHaveBeenCalled();
    expect(timelineSeek).not.toHaveBeenCalled();
  });

  function fakeBridgeOnlySeekPage() {
    const { page, evaluate } = fakeSeekPage();
    const bridgeSeek = vi.fn();
    const tickerTick = vi.fn();
    vi.stubGlobal("window", { __hf: { seek: bridgeSeek }, gsap: { ticker: { tick: tickerTick } } });
    return { page, evaluate, bridgeSeek, tickerTick };
  }

  it("keeps bridge and raw fallbacks disabled for default capture callers", async () => {
    const { page, evaluate, bridgeSeek, tickerTick } = fakeBridgeOnlySeekPage();

    await seekCompositionTimeline(page, 2.5);
    runBrowserSeek(evaluate);

    expect(bridgeSeek).not.toHaveBeenCalled();
    expect(tickerTick).not.toHaveBeenCalled();
  });

  it("opts into the bridge before player and raw timeline fallbacks", async () => {
    const { page, evaluate, bridgeSeek, tickerTick } = fakeBridgeOnlySeekPage();

    await seekCompositionTimeline(page, 2.5, { fallbackToBridgeAndTimelines: true });
    runBrowserSeek(evaluate);

    expect(bridgeSeek).toHaveBeenCalledWith(2.5);
    expect(tickerTick).toHaveBeenCalledOnce();
  });

  it("opts into pausing and seeking raw timelines when no preferred target exists", async () => {
    const { page, evaluate } = fakeSeekPage();
    const pause = vi.fn();
    const seek = vi.fn();
    vi.stubGlobal("window", { __timelines: { main: { pause, seek } } });

    await seekCompositionTimeline(page, 1.75, { fallbackToBridgeAndTimelines: true });
    runBrowserSeek(evaluate);

    expect(pause).toHaveBeenCalledOnce();
    expect(seek).toHaveBeenCalledWith(1.75);
  });

  it("supports validate settling without adding an animation-frame or font wait", async () => {
    vi.useFakeTimers();
    const { page, evaluate, waitForFunction } = fakeSeekPage();

    const pending = seekCompositionTimeline(page, 3, {
      fallbackToBridgeAndTimelines: true,
      waitForPreferredSeekTargetMs: 500,
      animationFrameSettle: "none",
      settleMs: 150,
    });
    await vi.advanceTimersByTimeAsync(150);
    await pending;

    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), 3, true);
  });

  it("supports layout's ordered double-frame, bounded font, and sleep settles", async () => {
    vi.useFakeTimers();
    const { page, evaluate } = fakeSeekPage();

    const pending = seekCompositionTimeline(page, 4, {
      fallbackToBridgeAndTimelines: true,
      animationFrameSettle: "double",
      waitForFontsMs: 500,
      settleMs: 120,
    });
    await vi.advanceTimersByTimeAsync(120);
    await pending;

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate).toHaveBeenNthCalledWith(1, expect.any(Function), 4, true);
    expect(evaluate).toHaveBeenNthCalledWith(2, expect.any(Function));
    expect(evaluate).toHaveBeenNthCalledWith(3, expect.any(Function), 500);
  });
});

describe("resolveCliChromeGpuMode", () => {
  it("preserves validate's software-only opt-in mapping", () => {
    expect(resolveCliChromeGpuMode("software")).toBe("software");
    expect(resolveCliChromeGpuMode("hardware")).toBe("hardware");
    expect(resolveCliChromeGpuMode("auto")).toBe("hardware");
    expect(resolveCliChromeGpuMode("")).toBe("hardware");
  });
});

describe("screenshot Chrome arguments", () => {
  it("leaves shared capture and layout on the engine's software default", () => {
    const defaultScreenshotArgs =
      /args:\s*buildChromeArgs\(\s*\{[^}]*captureMode:\s*"screenshot"[^}]*\}\s*\),/;
    const captureSource = readFileSync(
      new URL("./captureCompositionFrame.ts", import.meta.url),
      "utf8",
    );
    const layoutSource = readFileSync(new URL("../commands/layout.ts", import.meta.url), "utf8");

    expect(captureSource).toMatch(defaultScreenshotArgs);
    expect(layoutSource).toMatch(defaultScreenshotArgs);
  });
});

describe("runFfmpegOnce", () => {
  it("returns the process exit code and collected stderr", async () => {
    const dir = tempDir();
    try {
      const script = join(dir, "fail.cjs");
      writeFileSync(script, 'process.stderr.write("ffmpeg failed"); process.exit(3);\n');

      const result = await runFfmpegOnce(process.execPath, [script], 1000);

      expect(result).toEqual({ code: 3, stderr: "ffmpeg failed", timedOut: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminates the process when the timeout elapses", async () => {
    const dir = tempDir();
    try {
      const script = join(dir, "hang.cjs");
      writeFileSync(script, "setTimeout(() => {}, 10000);\n");

      const result = await runFfmpegOnce(process.execPath, [script], 50);

      expect(result.timedOut).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
