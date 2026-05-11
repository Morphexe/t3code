import { beforeEach, describe, expect, it } from "vitest";

import { isAppUpdatesPaused, noteAppInteraction, useAppActivityStore } from "./appActivityStore";

describe("appActivityStore", () => {
  beforeEach(() => {
    useAppActivityStore.setState({
      paused: false,
      lastInteractionAt: 1,
      pausedAt: null,
    });
  });

  it("reports paused state for update gating", () => {
    expect(isAppUpdatesPaused()).toBe(false);

    useAppActivityStore.getState().setPaused(true, 10);

    expect(isAppUpdatesPaused()).toBe(true);
    expect(useAppActivityStore.getState().pausedAt).toBe(10);
  });

  it("resumes and records the latest interaction time", () => {
    useAppActivityStore.getState().setPaused(true, 10);

    noteAppInteraction(42);

    expect(useAppActivityStore.getState()).toMatchObject({
      paused: false,
      lastInteractionAt: 42,
      pausedAt: null,
    });
  });
});
