import { type TimelineElement } from "../store/playerStore";
import { resolveContextOrder, resolveStackingContextKey } from "../lib/layerOrdering";
import { getTimelineElementIdentity } from "../lib/timelineElementHelpers";
import { toStackingOrderItem, type TimelineStackingOrderItem } from "./timelineEditing";

/**
 * Pure timeline track-ordering logic. Timeline rows are ordered by scoped
 * stacking (z-index per stacking context, top = front), with data-track-index
 * used only to split time-overlapping clips of equal rank onto separate rows.
 * Extracted from Timeline.tsx to keep the component under the studio 600-LOC cap.
 *
 * Key derivation and stacking-descriptor mapping are owned by timelineEditing so
 * the row order here and the reorder intent there interpret every element the
 * same way.
 */

type TimelineTrackOrderItem = TimelineStackingOrderItem & { start: number; duration: number };

function toTimelineTrackOrderItem(element: TimelineElement): TimelineTrackOrderItem {
  return { ...toStackingOrderItem(element), start: element.start, duration: element.duration };
}

function timelineElementsOverlap(
  a: Pick<TimelineElement, "start" | "duration">,
  b: Pick<TimelineElement, "start" | "duration">,
): boolean {
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}

function trackFrontOrderIndex(
  elements: readonly TimelineElement[],
  orderIndexByKey: ReadonlyMap<string, number>,
): number {
  let orderIndex = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    orderIndex = Math.min(
      orderIndex,
      orderIndexByKey.get(getTimelineElementIdentity(element)) ?? Number.POSITIVE_INFINITY,
    );
  }
  return orderIndex;
}

function hasOverlappingEqualRankElements(
  aElements: readonly TimelineElement[],
  bElements: readonly TimelineElement[],
): boolean {
  for (const a of aElements) {
    const aOrderItem = toTimelineTrackOrderItem(a);
    const aContextKey = resolveStackingContextKey(aOrderItem);
    for (const b of bElements) {
      const bOrderItem = toTimelineTrackOrderItem(b);
      if (aContextKey !== resolveStackingContextKey(bOrderItem)) continue;
      if (aOrderItem.zIndex !== bOrderItem.zIndex) continue;
      if (timelineElementsOverlap(a, b)) return true;
    }
  }
  return false;
}

export function buildStackingTimelineTracks(
  elements: readonly TimelineElement[],
): Array<[number, TimelineElement[]]> {
  const tracks = new Map<number, TimelineElement[]>();
  for (const element of elements) {
    const list = tracks.get(element.track) ?? [];
    list.push(element);
    tracks.set(element.track, list);
  }

  const orderedElements = resolveContextOrder(elements.map(toTimelineTrackOrderItem));
  const orderIndexByKey = new Map<string, number>();
  orderedElements.forEach((element, index) => {
    orderIndexByKey.set(element.key, index);
  });

  return Array.from(tracks.entries()).sort(([aTrack, aElements], [bTrack, bElements]) => {
    const aIndex = trackFrontOrderIndex(aElements, orderIndexByKey);
    const bIndex = trackFrontOrderIndex(bElements, orderIndexByKey);
    if (aIndex !== bIndex) return aIndex - bIndex;
    if (hasOverlappingEqualRankElements(aElements, bElements)) return aTrack - bTrack;
    const aStart = Math.min(...aElements.map((element) => element.start));
    const bStart = Math.min(...bElements.map((element) => element.start));
    if (aStart !== bStart) return aStart - bStart;
    return aTrack - bTrack;
  });
}

export function insertPreviewTrackOrder(
  trackOrder: readonly number[],
  previewTrack: number,
): number[] {
  if (trackOrder.includes(previewTrack)) return [...trackOrder];
  if (trackOrder.length === 0) return [previewTrack];
  const minTrack = Math.min(...trackOrder);
  const maxTrack = Math.max(...trackOrder);
  if (previewTrack < minTrack) return [previewTrack, ...trackOrder];
  if (previewTrack > maxTrack) return [...trackOrder, previewTrack];
  return [...trackOrder, previewTrack];
}
