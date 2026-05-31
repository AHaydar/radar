import type { RadarEvent } from './events.js';

/**
 * Sink — output surface for the watch pipeline.
 *
 * Each sink receives every RadarEvent emitted by watch.ts and decides what to
 * do with it. Sinks own their own display policy (verbosity, suppression,
 * rendering). watch.ts only describes *what happened*; sinks decide *what to show*.
 *
 * The dispatch loop wraps each `emit()` call in try/catch so a faulty sink
 * cannot kill sibling sinks.
 */
export interface Sink {
  emit(event: RadarEvent): void;

  /** Optional graceful shutdown — called once when `radar watch` exits. */
  close?(): Promise<void> | void;
}
