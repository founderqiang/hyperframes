import { type TimelineElement, usePlayerStore } from "../player/store/playerStore";
import { applyPatchByTarget, readAttributeByTarget } from "../utils/sourcePatcher";
import {
  formatTimelineAttributeNumber,
  resolveTimelineStackingReorderByTargetTrack,
  type TimelineStackingReorderIntent,
} from "../player/components/timelineEditing";
import { computeReorderZValues, getElementZIndex } from "../player/lib/layerOrdering";
import { getTimelineElementIdentity } from "../player/lib/timelineElementHelpers";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import { selectedKeyframePercentagesForElement } from "../utils/keyframeSelection";
import type { EditHistoryKind } from "../utils/editHistory";
import type { TimelineZIndexReorderCommit } from "./useTimelineEditingTypes";

function isHTMLElement(element: Element | null): element is HTMLElement {
  return element != null && element instanceof HTMLElement;
}

/**
 * Resolve a timeline vertical move to a z-index stacking reorder and commit it
 * through the shared layers-panel reorder path. Reads live sibling z-index from
 * the preview DOM, remaps with the dup-preserving reorder math, and writes only
 * z-index (never data-track-index). No-op when the move isn't a reorder, the
 * dragged clip is audio (no visual layer to restack), or the live siblings can't
 * be resolved. Extracted from StudioApp's timeline hook to keep it under the
 * studio 600-LOC cap.
 */
export function applyTimelineStackingReorder(input: {
  element: TimelineElement;
  targetTrack: number;
  stackingReorder: TimelineStackingReorderIntent | null | undefined;
  timelineElements: readonly TimelineElement[];
  iframe: HTMLIFrameElement | null;
  activeCompPath: string | null;
  commit: TimelineZIndexReorderCommit | null | undefined;
}): void {
  // Audio has no visual stacking; a vertical drag on it must never write z-index.
  if (input.element.tag === "audio") return;

  const intent =
    input.stackingReorder ??
    (input.targetTrack !== input.element.track
      ? resolveTimelineStackingReorderByTargetTrack({
          element: input.element,
          elements: input.timelineElements,
          targetTrack: input.targetTrack,
        })
      : null);
  if (intent == null || intent.fromIndex === intent.toIndex) return;

  const siblingByKey = new Map(
    input.timelineElements.map((el) => [getTimelineElementIdentity(el), el]),
  );
  const orderedSiblings = intent.siblingKeys
    .map((key) => siblingByKey.get(key) ?? null)
    .filter((sibling): sibling is TimelineElement => sibling != null);
  if (orderedSiblings.length !== intent.siblingKeys.length) return;

  const liveEntries = orderedSiblings
    .map((sibling) => ({ sibling, element: findTimelineElementInIframe(input.iframe, sibling) }))
    .filter((entry): entry is { sibling: TimelineElement; element: HTMLElement } =>
      isHTMLElement(entry.element),
    );
  if (liveEntries.length !== orderedSiblings.length) return;

  const reordered = [...liveEntries];
  const [moved] = reordered.splice(intent.fromIndex, 1);
  if (!moved) return;
  reordered.splice(intent.toIndex, 0, moved);

  const existingValues = liveEntries.map((entry) => getElementZIndex(entry.element));
  const zValues = computeReorderZValues(existingValues, intent.fromIndex, intent.toIndex);
  input.commit?.(
    reordered.map((entry, index) => ({
      element: entry.element,
      zIndex: zValues[index] ?? 0,
      id: entry.sibling.domId ?? entry.sibling.id,
      selector: entry.sibling.selector,
      selectorIndex: entry.sibling.selectorIndex,
      sourceFile: entry.sibling.sourceFile || input.activeCompPath || "index.html",
    })),
  );
}

/**
 * Remove the keyframes currently selected in the player store from the active
 * element's GSAP animation. Reads selection lazily so it stays correct when
 * invoked from a ref callback. Extracted from StudioApp to keep it under the
 * studio 600-LOC cap.
 */
export function deleteSelectedKeyframes(session: {
  selectedGsapAnimations: readonly { id: string; keyframes?: unknown }[];
  handleGsapRemoveKeyframe: (animId: string, pct: number) => void;
}): void {
  const { selectedKeyframes, selectedElementId } = usePlayerStore.getState();
  const animation = session.selectedGsapAnimations.find((anim) => anim.keyframes);
  if (!animation) return;
  // Only the active element's keyframes; a stale cross-element selection must not delete here.
  for (const pct of selectedKeyframePercentagesForElement(selectedKeyframes, selectedElementId)) {
    session.handleGsapRemoveKeyframe(animation.id, pct);
  }
}

// ── Types ──

export interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

export function buildPatchTarget(element: {
  domId?: string;
  hfId?: string;
  selector?: string;
  selectorIndex?: number;
}) {
  if (element.domId) {
    return {
      id: element.domId,
      hfId: element.hfId,
      selector: element.selector,
      selectorIndex: element.selectorIndex,
    };
  }
  if (element.hfId) {
    return { hfId: element.hfId, selector: element.selector, selectorIndex: element.selectorIndex };
  }
  if (element.selector) {
    return { selector: element.selector, selectorIndex: element.selectorIndex };
  }
  return null;
}

export type PatchTarget = NonNullable<ReturnType<typeof buildPatchTarget>>;

// The runtime re-reads data-start/data-duration from the DOM on each sync tick
// (packages/core/src/runtime/init.ts:1324-1368), so attribute mutations here are
// picked up automatically on the next frame without a rebind call.
export function findTimelineElementInIframe(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement,
): Element | null {
  try {
    const doc = iframe?.contentDocument;
    if (!doc) return null;
    return element.domId
      ? doc.getElementById(element.domId)
      : element.selector
        ? (doc.querySelectorAll(element.selector)[element.selectorIndex ?? 0] ?? null)
        : null;
  } catch {
    return null;
  }
}

export function patchIframeDomTiming(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement,
  attrs: Array<[string, string]>,
): void {
  try {
    const el = findTimelineElementInIframe(iframe, element);
    if (!el) return;
    for (const [name, value] of attrs) el.setAttribute(name, value);
  } catch {
    // Cross-origin or mid-navigation — file save is enqueued; iframe patch is best-effort.
  }
}

// fallow-ignore-next-line complexity
export function resolveResizePlaybackStart(
  original: string,
  target: PatchTarget,
  element: TimelineElement,
  updates: Pick<TimelineElement, "start" | "playbackStart">,
): { attrName: string; value: number } | null {
  if (updates.playbackStart != null) {
    const attrName =
      element.playbackStartAttr === "playback-start" ? "playback-start" : "media-start";
    return { attrName, value: updates.playbackStart };
  }
  const trimDelta = updates.start - element.start;
  if (trimDelta === 0) return null;
  const raw =
    readAttributeByTarget(original, target, "playback-start") ??
    readAttributeByTarget(original, target, "media-start");
  const current = raw != null ? parseFloat(raw) : undefined;
  if (current == null || !Number.isFinite(current)) return null;
  const attrName =
    element.playbackStartAttr === "playback-start" ? "playback-start" : "media-start";
  return {
    attrName,
    value: Math.max(0, current + trimDelta * Math.max(element.playbackRate ?? 1, 0.1)),
  };
}

export interface PersistTimelineEditInput {
  projectId: string;
  element: TimelineElement;
  activeCompPath: string | null;
  label: string;
  buildPatches: (original: string, target: PatchTarget) => string;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  pendingTimelineEditPathRef: React.MutableRefObject<Set<string>>;
  coalesceKey?: string;
}

export async function persistTimelineEdit(input: PersistTimelineEditInput): Promise<void> {
  const targetPath = input.element.sourceFile || input.activeCompPath || "index.html";
  const originalContent = await readFileContent(input.projectId, targetPath);

  const patchTarget = buildPatchTarget(input.element);
  if (!patchTarget) {
    throw new Error(`Timeline element ${input.element.id} is missing a patchable target`);
  }

  const patchedContent = input.buildPatches(originalContent, patchTarget);
  if (patchedContent === originalContent) {
    throw new Error(`Unable to patch timeline element ${input.element.id} in ${targetPath}`);
  }

  input.pendingTimelineEditPathRef.current.add(targetPath);
  input.domEditSaveTimestampRef.current = Date.now();
  await saveProjectFilesWithHistory({
    projectId: input.projectId,
    label: input.label,
    kind: "timeline",
    coalesceKey: input.coalesceKey,
    files: { [targetPath]: patchedContent },
    readFile: async () => originalContent,
    writeFile: input.writeProjectFile,
    recordEdit: input.recordEdit,
  });
  input.domEditSaveTimestampRef.current = Date.now();
}

export async function readFileContent(projectId: string, targetPath: string): Promise<string> {
  if (targetPath.includes("\0") || targetPath.includes("..")) {
    throw new Error(`Unsafe path: ${targetPath}`);
  }
  const response = await fetch(
    `/api/projects/${projectId}/files/${encodeURIComponent(targetPath)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to read ${targetPath}`);
  }
  const data = (await response.json()) as { content?: string };
  if (typeof data.content !== "string") {
    throw new Error(`Missing file contents for ${targetPath}`);
  }
  return data.content;
}

/**
 * Shift all GSAP animation positions targeting a given element by a time delta.
 * Calls the server-side GSAP mutation endpoint which uses the AST-based parser.
 */
export async function shiftGsapPositions(
  projectId: string,
  filePath: string,
  elementId: string,
  delta: number,
): Promise<void> {
  if (delta === 0 || !elementId) return;
  const res = await fetch(
    `/api/projects/${projectId}/gsap-mutations/${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "shift-positions",
        targetSelector: `#${elementId}`,
        delta,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err as { error?: string })?.error ?? "shift-positions failed");
  }
}

export async function scaleGsapPositions(
  projectId: string,
  filePath: string,
  elementId: string,
  oldStart: number,
  oldDuration: number,
  newStart: number,
  newDuration: number,
): Promise<void> {
  if (!elementId || oldDuration <= 0 || newDuration <= 0) return;
  if (oldStart === newStart && oldDuration === newDuration) return;
  const res = await fetch(
    `/api/projects/${projectId}/gsap-mutations/${encodeURIComponent(filePath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "scale-positions",
        targetSelector: `#${elementId}`,
        oldStart,
        oldDuration,
        newStart,
        newDuration,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err as { error?: string })?.error ?? "scale-positions failed");
  }
}

// Re-export applyPatchByTarget for use in the hook (avoids double import in callers)
export { applyPatchByTarget, formatTimelineAttributeNumber };
