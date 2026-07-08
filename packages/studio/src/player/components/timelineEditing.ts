import { formatTime } from "../lib/time";
import { roundToCenti } from "../../utils/rounding";
import { resolveContextOrder, resolveStackingContextKey } from "../lib/layerOrdering";
import { getTimelineElementIdentity } from "../lib/timelineElementHelpers";

const roundToCentiseconds = roundToCenti;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * A timeline clip described for stacking-order math: its track (timeline row),
 * resolved z-index, and stacking-context identity. Structurally satisfied by the
 * app's TimelineElement.
 */
export interface TimelineStackingElement {
  id: string;
  key?: string;
  track: number;
  zIndex?: number;
  stackingContextId?: string | null;
  parentCompositionId?: string | null;
  compositionAncestors?: string[];
}

/** A resolved vertical reorder: move the dragged clip from `fromIndex` to
 *  `toIndex` within its stacking context's ordered siblings (top = front). */
export interface TimelineStackingReorderIntent {
  contextKey: string;
  fromIndex: number;
  toIndex: number;
  siblingKeys: string[];
}

export interface TimelineStackingOrderItem {
  key: string;
  track: number;
  zIndex: number;
  stackingContextId: string | null;
  parentCompositionId: string | null;
  compositionAncestors: readonly string[];
}

export function toStackingOrderItem(element: TimelineStackingElement): TimelineStackingOrderItem {
  return {
    key: getTimelineElementIdentity(element),
    track: element.track,
    zIndex: element.zIndex ?? 0,
    stackingContextId: element.stackingContextId ?? null,
    parentCompositionId: element.parentCompositionId ?? null,
    compositionAncestors: element.compositionAncestors ?? [],
  };
}

/** Ordered siblings of `element` within its own stacking context (z-index desc,
 *  DOM order tiebreak) — the unit a vertical reorder operates on. */
function resolveContextSiblings(
  element: TimelineStackingElement,
  elements: readonly TimelineStackingElement[],
): TimelineStackingOrderItem[] {
  const contextKey = resolveStackingContextKey(toStackingOrderItem(element));
  const items = elements
    .map(toStackingOrderItem)
    .filter((item) => resolveStackingContextKey(item) === contextKey);
  return resolveContextOrder(items);
}

/**
 * Resolve the reorder implied by dropping `element` onto `targetTrack` (the track
 * of the sibling whose slot it lands in). Returns null when the element has no
 * reorderable siblings or the target track matches no sibling.
 */
export function resolveTimelineStackingReorderByTargetTrack(args: {
  element: TimelineStackingElement;
  elements: readonly TimelineStackingElement[];
  targetTrack: number;
}): TimelineStackingReorderIntent | null {
  const orderedSiblings = resolveContextSiblings(args.element, args.elements);
  if (orderedSiblings.length <= 1) return null;
  const fromIndex = orderedSiblings.findIndex(
    (sibling) => sibling.key === getTimelineElementIdentity(args.element),
  );
  if (fromIndex < 0) return null;
  const toIndex = orderedSiblings.findIndex((sibling) => sibling.track === args.targetTrack);
  if (toIndex < 0) return null;
  return {
    contextKey: resolveStackingContextKey(toStackingOrderItem(args.element)),
    fromIndex,
    toIndex,
    siblingKeys: orderedSiblings.map((sibling) => sibling.key),
  };
}

const EDGE_TRACK_CREATE_THRESHOLD = 0.55;
const AUTO_SCROLL_EDGE_ZONE = 40;
const AUTO_SCROLL_MAX_SPEED = 12;

export interface TimelineMoveInput {
  start: number;
  track: number;
  duration: number;
  originClientX: number;
  originClientY: number;
  originScrollLeft?: number;
  originScrollTop?: number;
  currentScrollLeft?: number;
  currentScrollTop?: number;
  pixelsPerSecond: number;
  trackHeight: number;
  maxStart: number;
  trackOrder: number[];
  /** When provided, vertical movement is resolved as a z-index stacking reorder
   *  within `stackingElement`'s context instead of a raw track change. */
  stackingElement?: TimelineStackingElement;
  stackingElements?: TimelineStackingElement[];
}

export interface TimelineResizeInput {
  start: number;
  duration: number;
  originClientX: number;
  pixelsPerSecond: number;
  minStart: number;
  maxEnd: number;
  minDuration?: number;
  playbackStart?: number;
  playbackRate?: number;
}

export interface TimelineAutoScrollBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function resolveTimelineAutoScroll(
  bounds: TimelineAutoScrollBounds,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const getAxisDelta = (start: number, end: number, pointer: number) => {
    if (pointer < start + AUTO_SCROLL_EDGE_ZONE) {
      const proximity = Math.max(0, 1 - (pointer - start) / AUTO_SCROLL_EDGE_ZONE);
      return -Math.round(AUTO_SCROLL_MAX_SPEED * proximity);
    }
    if (pointer > end - AUTO_SCROLL_EDGE_ZONE) {
      const proximity = Math.max(0, 1 - (end - pointer) / AUTO_SCROLL_EDGE_ZONE);
      return Math.round(AUTO_SCROLL_MAX_SPEED * proximity);
    }
    return 0;
  };

  return {
    x: getAxisDelta(bounds.left, bounds.right, clientX),
    y: getAxisDelta(bounds.top, bounds.bottom, clientY),
  };
}

export function resolveTimelineMove(
  input: TimelineMoveInput,
  clientX: number,
  clientY: number,
): { start: number; track: number; stackingReorder?: TimelineStackingReorderIntent } {
  const scrollDeltaX = (input.currentScrollLeft ?? 0) - (input.originScrollLeft ?? 0);
  const scrollDeltaY = (input.currentScrollTop ?? 0) - (input.originScrollTop ?? 0);
  const deltaTime =
    (clientX - input.originClientX + scrollDeltaX) / Math.max(input.pixelsPerSecond, 1);
  const trackDeltaRaw =
    (clientY - input.originClientY + scrollDeltaY) / Math.max(input.trackHeight, 1);
  const deltaTrack = Math.round(trackDeltaRaw);
  const nextStart = clamp(
    roundToCentiseconds(input.start + deltaTime),
    0,
    Math.max(0, input.maxStart),
  );

  // Stacking mode: vertical movement reorders z-index within the dragged clip's
  // stacking context (top = front), rather than changing the raw track number.
  if (input.stackingElement && input.stackingElements) {
    const orderedSiblings = resolveContextSiblings(input.stackingElement, input.stackingElements);
    const draggedKey = getTimelineElementIdentity(input.stackingElement);
    const fromIndex = orderedSiblings.findIndex((sibling) => sibling.key === draggedKey);
    if (fromIndex >= 0 && orderedSiblings.length > 1) {
      const toIndex = clamp(fromIndex + deltaTrack, 0, orderedSiblings.length - 1);
      return {
        start: nextStart,
        track: orderedSiblings[toIndex]!.track,
        stackingReorder: {
          contextKey: resolveStackingContextKey(toStackingOrderItem(input.stackingElement)),
          fromIndex,
          toIndex,
          siblingKeys: orderedSiblings.map((sibling) => sibling.key),
        },
      };
    }
  }

  const currentTrackIndex = Math.max(0, input.trackOrder.indexOf(input.track));
  const desiredTrackIndex = currentTrackIndex + deltaTrack;
  const nextTrackIndex = clamp(desiredTrackIndex, 0, Math.max(0, input.trackOrder.length - 1));
  const minTrack = Math.min(...input.trackOrder);
  const maxTrack = Math.max(...input.trackOrder);
  let nextTrack = input.trackOrder[nextTrackIndex] ?? input.track;

  const startedOnFirstTrack = currentTrackIndex === 0;
  const startedOnLastTrack = currentTrackIndex === input.trackOrder.length - 1;

  if (
    startedOnFirstTrack &&
    desiredTrackIndex < 0 &&
    currentTrackIndex + trackDeltaRaw <= -EDGE_TRACK_CREATE_THRESHOLD
  ) {
    nextTrack = minTrack - 1;
  } else if (
    startedOnLastTrack &&
    desiredTrackIndex > input.trackOrder.length - 1 &&
    currentTrackIndex + trackDeltaRaw >= input.trackOrder.length - 1 + EDGE_TRACK_CREATE_THRESHOLD
  ) {
    nextTrack = maxTrack + 1;
  }

  return {
    start: nextStart,
    track: nextTrack,
  };
}

/**
 * Snap a keyframe's clip-relative percentage to the nearest beat within ~8px,
 * mapping through composition time (pct → time → nearest beat → pct). Returns
 * the percentage unchanged when no beat is in range, so dragging stays free
 * between beats.
 */
export function snapKeyframePctToBeat(
  el: { start: number; duration: number },
  pct: number,
  beatTimes: number[] | undefined,
  pixelsPerSecond: number,
): number {
  if (!beatTimes || beatTimes.length === 0 || el.duration <= 0) return pct;
  const t = el.start + (pct / 100) * el.duration;
  const snapSecs = 8 / Math.max(pixelsPerSecond, 1);
  let best = t;
  let bestDist = snapSecs;
  for (const bt of beatTimes) {
    const d = Math.abs(bt - t);
    if (d < bestDist) {
      bestDist = d;
      best = bt;
    }
  }
  if (best === t) return pct;
  return Math.max(0, Math.min(100, ((best - el.start) / el.duration) * 100));
}

export function resolveTimelineResize(
  input: TimelineResizeInput,
  edge: "start" | "end",
  clientX: number,
): { start: number; duration: number; playbackStart?: number } {
  const minDuration = Math.max(0.05, input.minDuration ?? 0.1);
  const deltaTime = (clientX - input.originClientX) / Math.max(input.pixelsPerSecond, 1);

  if (edge === "end") {
    const nextDuration = clamp(
      roundToCentiseconds(input.duration + deltaTime),
      minDuration,
      Math.max(minDuration, input.maxEnd - input.start),
    );
    return {
      start: input.start,
      duration: nextDuration,
      playbackStart: input.playbackStart,
    };
  }

  const playbackRate = Math.max(0.1, input.playbackRate ?? 1);
  const maxLeftExtensionFromMedia =
    input.playbackStart != null ? input.playbackStart / playbackRate : Number.POSITIVE_INFINITY;
  const minDelta = -Math.min(input.start - input.minStart, maxLeftExtensionFromMedia);
  const maxDelta = input.duration - minDuration;
  const clampedDelta = clamp(deltaTime, minDelta, maxDelta);
  const nextStart = roundToCentiseconds(input.start + clampedDelta);
  const nextDuration = roundToCentiseconds(input.duration - clampedDelta);
  const nextPlaybackStart =
    input.playbackStart != null
      ? roundToCentiseconds(Math.max(0, input.playbackStart + clampedDelta * playbackRate))
      : undefined;

  return {
    start: nextStart,
    duration: nextDuration,
    playbackStart: nextPlaybackStart,
  };
}

export interface TimelinePromptElement {
  id: string;
  tag: string;
  start: number;
  duration: number;
  track: number;
}

export interface TimelineEditCapabilities {
  canMove: boolean;
  canTrimStart: boolean;
  canTrimEnd: boolean;
}

export type BlockedTimelineEditIntent = "move" | "resize-start" | "resize-end";

export interface TimelineRangeSelection {
  start: number;
  end: number;
  anchorX: number;
  anchorY: number;
}

function isDeterministicTimelineWindow(input: {
  tag: string;
  compositionSrc?: string;
  playbackStartAttr?: "media-start" | "playback-start";
  sourceDuration?: number;
}): boolean {
  if (input.compositionSrc) return true;
  if (input.playbackStartAttr != null) return true;
  if (
    input.sourceDuration != null &&
    Number.isFinite(input.sourceDuration) &&
    input.sourceDuration > 0
  ) {
    return true;
  }
  const normalizedTag = input.tag.toLowerCase();
  return ["video", "audio", "img"].includes(normalizedTag);
}

export function hasPatchableTimelineTarget(input: { domId?: string; selector?: string }): boolean {
  return Boolean(input.domId || input.selector);
}

export function getTimelineEditCapabilities(input: {
  tag: string;
  duration: number;
  domId?: string;
  selector?: string;
  compositionSrc?: string;
  playbackStart?: number;
  playbackStartAttr?: "media-start" | "playback-start";
  sourceDuration?: number;
  timingSource?: "authored" | "implicit";
  timelineLocked?: boolean;
}): TimelineEditCapabilities {
  if (input.timingSource === "implicit" || input.timelineLocked) {
    return {
      canMove: false,
      canTrimStart: false,
      canTrimEnd: false,
    };
  }

  const canPatch = hasPatchableTimelineTarget(input);
  const hasFiniteDuration = Number.isFinite(input.duration) && input.duration > 0;
  const hasDeterministicWindow = isDeterministicTimelineWindow(input);
  return {
    canMove: canPatch && (hasDeterministicWindow || hasFiniteDuration),
    canTrimEnd: canPatch && hasFiniteDuration,
    canTrimStart: canPatch && hasFiniteDuration,
  };
}

export function resolveBlockedTimelineEditIntent(input: {
  width: number;
  offsetX: number;
  handleWidth: number;
  capabilities: TimelineEditCapabilities;
}): BlockedTimelineEditIntent | null {
  if (input.capabilities.canMove) {
    return null;
  }

  const safeWidth = Math.max(0, input.width);
  const safeOffsetX = clamp(input.offsetX, 0, safeWidth);
  const safeHandleWidth = Math.max(0, input.handleWidth);

  if (safeOffsetX <= safeHandleWidth && !input.capabilities.canTrimStart) {
    return "resize-start";
  }
  if (safeOffsetX >= Math.max(0, safeWidth - safeHandleWidth) && !input.capabilities.canTrimEnd) {
    return "resize-end";
  }
  return "move";
}

export function buildClipRangeSelection(
  clip: { start: number; duration: number },
  anchor: { anchorX: number; anchorY: number },
): TimelineRangeSelection {
  return {
    start: clip.start,
    end: clip.start + clip.duration,
    anchorX: anchor.anchorX,
    anchorY: anchor.anchorY,
  };
}
export function buildTimelineAgentPrompt({
  rangeStart,
  rangeEnd,
  elements,
  prompt,
}: {
  rangeStart: number;
  rangeEnd: number;
  elements: TimelinePromptElement[];
  prompt: string;
}): string {
  const start = Math.min(rangeStart, rangeEnd);
  const end = Math.max(rangeStart, rangeEnd);
  const elementLines = elements
    .map(
      (el) =>
        `- #${el.id} (${el.tag}) — ${formatTime(el.start)} to ${formatTime(el.start + el.duration)}, track ${el.track}`,
    )
    .join("\n");

  return `Edit the following HyperFrames composition:

Time range: ${formatTime(start)} — ${formatTime(end)}

Elements in range:
${elementLines || "(none)"}

User request:
${prompt.trim() || "(no prompt provided)"}

Instructions:
Modify only the elements listed above within the specified time range.
The composition uses HyperFrames data attributes (data-start, data-duration, data-track-index) and GSAP for animations.
Preserve all other elements and timing outside this range.`;
}

export function buildPromptCopyText(prompt: string): string {
  return prompt.trim();
}

export function buildTimelineElementAgentPrompt(element: {
  id: string;
  tag: string;
  start: number;
  duration: number;
  track: number;
  sourceFile?: string;
  selector?: string;
  compositionSrc?: string;
}): string {
  const lines = [
    "Studio cannot directly move or resize this timeline clip because its visible timing is not fully controlled by patchable HTML timing attributes.",
    "",
    "Please update the source so the clip's actual visible timing stays consistent with the authored timeline.",
    "",
    "Clip:",
    `- id: ${element.id}`,
    `- tag: ${element.tag}`,
    `- time: ${formatTime(element.start)} to ${formatTime(element.start + element.duration)}`,
    `- track: ${element.track}`,
  ];

  if (element.sourceFile) lines.push(`- source file: ${element.sourceFile}`);
  if (element.selector) lines.push(`- selector: ${element.selector}`);
  if (element.compositionSrc) lines.push(`- composition src: ${element.compositionSrc}`);

  lines.push(
    "",
    "If this clip is animated with GSAP or another JS timeline, update the authored animation timing there as well instead of only changing data-start/data-duration.",
  );

  return lines.join("\n");
}
export function formatTimelineAttributeNumber(value: number): string {
  return Number(roundToCentiseconds(value).toFixed(2)).toString();
}
