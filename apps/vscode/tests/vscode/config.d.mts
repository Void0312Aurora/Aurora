export interface ReplayOverlayOptions {
  directoryPickerModule: string
  replayModule: string
}

/** Render the deterministic CLI overlay used by the built Extension Host lane. */
export function renderReplayOverlay(options: ReplayOverlayOptions): string
