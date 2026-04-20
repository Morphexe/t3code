import { isLatestTurnSettled } from "./session-logic";
import type { NotificationSoundPreset } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "./types";

interface AgentNotificationThreadState {
  requiresInput: boolean;
  completedTurnKey: string | null;
}

export interface AgentNotificationTransition {
  next: Map<string, AgentNotificationThreadState>;
  shouldPlayRequiresInputSound: boolean;
  shouldPlayFinishedSound: boolean;
}

function getThreadKey(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return `${thread.environmentId}:${thread.id}`;
}

function getCompletedTurnKey(thread: SidebarThreadSummary): string | null {
  const latestTurn = thread.latestTurn;
  if (!latestTurn || !isLatestTurnSettled(latestTurn, thread.session)) {
    return null;
  }
  if (!latestTurn.completedAt) {
    return null;
  }
  return `${latestTurn.turnId}:${latestTurn.completedAt}:${latestTurn.state}`;
}

function toThreadState(thread: SidebarThreadSummary): AgentNotificationThreadState {
  return {
    requiresInput: thread.hasPendingApprovals || thread.hasPendingUserInput,
    completedTurnKey: getCompletedTurnKey(thread),
  };
}

export function deriveAgentNotificationTransition(
  previous: ReadonlyMap<string, AgentNotificationThreadState> | null,
  threads: ReadonlyArray<SidebarThreadSummary>,
): AgentNotificationTransition {
  const next = new Map<string, AgentNotificationThreadState>();
  let shouldPlayRequiresInputSound = false;
  let shouldPlayFinishedSound = false;

  for (const thread of threads) {
    const threadKey = getThreadKey(thread);
    const nextThreadState = toThreadState(thread);
    next.set(threadKey, nextThreadState);

    if (!previous) {
      continue;
    }

    const previousThreadState = previous.get(threadKey);
    if (!previousThreadState) {
      continue;
    }

    if (!previousThreadState.requiresInput && nextThreadState.requiresInput) {
      shouldPlayRequiresInputSound = true;
    }

    if (
      nextThreadState.completedTurnKey !== null &&
      previousThreadState.completedTurnKey !== nextThreadState.completedTurnKey
    ) {
      shouldPlayFinishedSound = true;
    }
  }

  return {
    next,
    shouldPlayRequiresInputSound,
    shouldPlayFinishedSound,
  };
}

let audioContextPromise: Promise<AudioContext | null> | null = null;

function hasAudioContext(): boolean {
  return typeof window !== "undefined" && typeof window.AudioContext === "function";
}

async function getAudioContext(): Promise<AudioContext | null> {
  if (!hasAudioContext()) {
    return null;
  }

  if (!audioContextPromise) {
    audioContextPromise = Promise.resolve(new window.AudioContext());
  }

  const context = await audioContextPromise;
  if (!context) {
    return null;
  }

  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return null;
    }
  }

  return context;
}

function scheduleTone(
  context: AudioContext,
  input: {
    startAt: number;
    durationMs: number;
    frequency: number;
    volume: number;
    type?: OscillatorType;
    detune?: number;
    attackMs?: number;
    endFrequency?: number;
  },
): void {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const startAt = input.startAt;
  const durationSeconds = input.durationMs / 1_000;
  const attackSeconds = Math.max(0.001, (input.attackMs ?? 8) / 1_000);
  const peakAt = startAt + attackSeconds;
  const endAt = startAt + durationSeconds;

  oscillator.type = input.type ?? "sine";
  oscillator.frequency.setValueAtTime(input.frequency, startAt);
  oscillator.detune.setValueAtTime(input.detune ?? 0, startAt);
  if (input.endFrequency && input.endFrequency !== input.frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(input.endFrequency, endAt);
  }

  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.linearRampToValueAtTime(input.volume, peakAt);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt + 0.02);
}

function scheduleBell(context: AudioContext, startAt: number): number {
  scheduleTone(context, {
    startAt,
    durationMs: 290,
    frequency: 880,
    endFrequency: 760,
    volume: 0.08,
    type: "sine",
    detune: -4,
    attackMs: 10,
  });
  scheduleTone(context, {
    startAt: startAt + 0.012,
    durationMs: 340,
    frequency: 1320,
    endFrequency: 1180,
    volume: 0.045,
    type: "triangle",
    detune: 3,
    attackMs: 12,
  });
  return 340;
}

function scheduleChime(context: AudioContext, startAt: number): number {
  scheduleTone(context, {
    startAt,
    durationMs: 160,
    frequency: 660,
    volume: 0.06,
    type: "triangle",
    attackMs: 8,
  });
  scheduleTone(context, {
    startAt: startAt + 0.11,
    durationMs: 240,
    frequency: 990,
    endFrequency: 880,
    volume: 0.075,
    type: "sine",
    attackMs: 10,
  });
  return 350;
}

function scheduleGlass(context: AudioContext, startAt: number): number {
  scheduleTone(context, {
    startAt,
    durationMs: 240,
    frequency: 1046,
    endFrequency: 988,
    volume: 0.045,
    type: "triangle",
    detune: -6,
    attackMs: 6,
  });
  scheduleTone(context, {
    startAt: startAt + 0.03,
    durationMs: 300,
    frequency: 1568,
    endFrequency: 1396,
    volume: 0.03,
    type: "sine",
    detune: 7,
    attackMs: 6,
  });
  return 330;
}

function schedulePop(context: AudioContext, startAt: number): number {
  scheduleTone(context, {
    startAt,
    durationMs: 90,
    frequency: 420,
    endFrequency: 520,
    volume: 0.055,
    type: "triangle",
    attackMs: 4,
  });
  scheduleTone(context, {
    startAt: startAt + 0.045,
    durationMs: 110,
    frequency: 640,
    endFrequency: 820,
    volume: 0.04,
    type: "sine",
    attackMs: 4,
  });
  return 155;
}

function schedulePreset(
  context: AudioContext,
  preset: Exclude<NotificationSoundPreset, "off">,
  startAt: number,
): number {
  switch (preset) {
    case "bell":
      return scheduleBell(context, startAt);
    case "chime":
      return scheduleChime(context, startAt);
    case "glass":
      return scheduleGlass(context, startAt);
    case "pop":
      return schedulePop(context, startAt);
  }
}

export async function playNotificationSoundPreset(
  preset: NotificationSoundPreset,
): Promise<number> {
  if (preset === "off") {
    return 0;
  }

  const context = await getAudioContext();
  if (!context) {
    return 0;
  }

  return schedulePreset(context, preset, context.currentTime + 0.01);
}

export async function playNotificationSoundSequence(
  presets: ReadonlyArray<NotificationSoundPreset>,
): Promise<void> {
  const activePresets = presets.filter((preset) => preset !== "off");
  if (activePresets.length === 0) {
    return;
  }

  const context = await getAudioContext();
  if (!context) {
    return;
  }

  let nextStartAt = context.currentTime + 0.01;
  for (const preset of activePresets) {
    nextStartAt += schedulePreset(context, preset, nextStartAt) / 1_000 + 0.05;
  }
}

export function __clearAgentNotificationSoundStateForTests(): void {
  audioContextPromise = null;
}
