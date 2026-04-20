import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ClientSettingsSchema,
  DEFAULT_AGENT_FINISHED_SOUND,
  DEFAULT_AGENT_REQUIRES_INPUT_SOUND,
  DEFAULT_CLIENT_SETTINGS,
} from "./settings.ts";

describe("ClientSettingsSchema", () => {
  it("defaults agent notification sounds", () => {
    expect(DEFAULT_CLIENT_SETTINGS.agentRequiresInputSound).toBe(
      DEFAULT_AGENT_REQUIRES_INPUT_SOUND,
    );
    expect(DEFAULT_CLIENT_SETTINGS.agentFinishedSound).toBe(DEFAULT_AGENT_FINISHED_SOUND);
  });

  it("migrates older persisted documents without notification sound settings", () => {
    const decoded = Schema.decodeSync(ClientSettingsSchema)({
      timestampFormat: "24-hour",
    });

    expect(decoded.agentRequiresInputSound).toBe(DEFAULT_AGENT_REQUIRES_INPUT_SOUND);
    expect(decoded.agentFinishedSound).toBe(DEFAULT_AGENT_FINISHED_SOUND);
    expect(decoded.timestampFormat).toBe("24-hour");
  });
});
