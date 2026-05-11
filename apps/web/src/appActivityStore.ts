import { create } from "zustand";

export const APP_INACTIVITY_PAUSE_MS = 30_000;

export interface AppActivityState {
  paused: boolean;
  lastInteractionAt: number;
  pausedAt: number | null;
}

interface AppActivityStore extends AppActivityState {
  noteInteraction: (at?: number) => void;
  setPaused: (paused: boolean, at?: number) => void;
}

const initialLastInteractionAt = Date.now();

export const useAppActivityStore = create<AppActivityStore>((set) => ({
  paused: false,
  lastInteractionAt: initialLastInteractionAt,
  pausedAt: null,
  noteInteraction: (at = Date.now()) =>
    set((state) => {
      if (!state.paused && state.lastInteractionAt === at) {
        return state;
      }
      return {
        ...state,
        paused: false,
        lastInteractionAt: at,
        pausedAt: null,
      };
    }),
  setPaused: (paused, at = Date.now()) =>
    set((state) => {
      if (state.paused === paused) {
        return state;
      }
      return {
        ...state,
        paused,
        pausedAt: paused ? at : null,
      };
    }),
}));

export function isAppUpdatesPaused(): boolean {
  return useAppActivityStore.getState().paused;
}

export function noteAppInteraction(at?: number): void {
  useAppActivityStore.getState().noteInteraction(at);
}

export function startAppActivityMonitor(options?: {
  readonly inactivityMs?: number;
  readonly onResumeFromPause?: () => void;
}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const inactivityMs = options?.inactivityMs ?? APP_INACTIVITY_PAUSE_MS;
  let timeoutId: number | null = null;

  const clearPauseTimer = () => {
    if (timeoutId === null) {
      return;
    }
    window.clearTimeout(timeoutId);
    timeoutId = null;
  };

  const schedulePauseTimer = () => {
    clearPauseTimer();
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      useAppActivityStore.getState().setPaused(true);
    }, inactivityMs);
  };

  const handleInteraction = () => {
    const hadBeenPaused = useAppActivityStore.getState().paused;
    useAppActivityStore.getState().noteInteraction();
    schedulePauseTimer();
    if (hadBeenPaused) {
      options?.onResumeFromPause?.();
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      handleInteraction();
    }
  };

  const eventOptions = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", handleInteraction, eventOptions);
  window.addEventListener("keydown", handleInteraction, { capture: true });
  window.addEventListener("wheel", handleInteraction, eventOptions);
  window.addEventListener("touchstart", handleInteraction, eventOptions);
  window.addEventListener("focus", handleInteraction);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  schedulePauseTimer();

  return () => {
    clearPauseTimer();
    window.removeEventListener("pointerdown", handleInteraction, eventOptions);
    window.removeEventListener("keydown", handleInteraction, { capture: true });
    window.removeEventListener("wheel", handleInteraction, eventOptions);
    window.removeEventListener("touchstart", handleInteraction, eventOptions);
    window.removeEventListener("focus", handleInteraction);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
