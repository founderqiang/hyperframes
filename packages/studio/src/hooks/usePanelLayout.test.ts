// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { usePanelLayout } from "./usePanelLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function renderPanelLayout() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let current: ReturnType<typeof usePanelLayout> | null = null;

  function Harness() {
    current = usePanelLayout();
    return null;
  }

  act(() => {
    root.render(React.createElement(Harness));
  });

  return {
    getState: (): ReturnType<typeof usePanelLayout> => {
      if (!current) throw new Error("usePanelLayout did not render");
      return current;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe("usePanelLayout — right inspector panes", () => {
  it("toggleRightInspectorPane independently flips one pane, allowing both open at once", () => {
    const harness = renderPanelLayout();
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: false, design: true });

    act(() => harness.getState().toggleRightInspectorPane("layers"));
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: true, design: true });

    harness.unmount();
  });

  it("toggleRightInspectorPane refuses to turn off the last remaining pane", () => {
    const harness = renderPanelLayout();
    act(() => harness.getState().toggleRightInspectorPane("design"));
    // Only "design" was on; toggling it off would leave both false — guarded.
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: false, design: true });
    harness.unmount();
  });

  it("setExclusiveRightInspectorPane is radio-style — selecting one turns the other off", () => {
    const harness = renderPanelLayout();
    act(() => harness.getState().toggleRightInspectorPane("layers"));
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: true, design: true });

    act(() => harness.getState().setExclusiveRightInspectorPane("layers"));
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: true, design: false });

    act(() => harness.getState().setExclusiveRightInspectorPane("design"));
    expect(harness.getState().rightInspectorPanes).toEqual({ layers: false, design: true });

    harness.unmount();
  });
});
