import type { Sink } from '../sink.js';
import { assertNever } from '../events.js';
import type { RadarEvent } from '../events.js';
import {
  printBanner,
  printPreClear,
  printPreAdvisory,
  printPostAligned,
  printPostMisaligned,
  printSessionStart,
  printSuppressedCount,
  printWarning,
  printError,
  printDebug,
} from '../formatter.js';

/**
 * LogSink — the default output surface. Wraps all formatter.ts print*
 * functions and owns the display policy:
 *
 * - verbose=false (default / alert-only mode): pre.clear and post.aligned
 *   events are suppressed and counted. The suppressed count is flushed
 *   (printed as "… N events clear …") immediately before any alert line.
 * - verbose=true: every event is printed; flush still happens before alerts
 *   for consistent ordering.
 *
 * pause()/resume() — while the Ink dashboard is active, LogSink is paused.
 * All events are silently dropped (Ink owns the screen). On resume(), printing
 * resumes; the scroll buffer shows pre-dashboard content (htop/vim UX).
 */
export class LogSink implements Sink {
  private suppressed = 0;
  private paused = false;

  constructor(private readonly opts: { verbose: boolean }) {}

  /** Pause output — called when the Ink dashboard becomes active. */
  pause(): void {
    this.paused = true;
  }

  /** Resume output — called when the Ink dashboard exits. */
  resume(): void {
    this.paused = false;
  }

  emit(e: RadarEvent): void {
    if (this.paused) return;

    switch (e.type) {
      case 'pre.clear': {
        if (this.opts.verbose) {
          this.flush();
          // Use agent displayName in the header if available; label drives color fallback
          const displayLabel = e.agent?.displayName ?? e.label;
          printPreClear(e.score, displayLabel);
        } else {
          this.suppressed++;
        }
        return;
      }

      case 'pre.advisory': {
        this.flush();
        const displayLabel = e.agent?.displayName ?? e.label;
        printPreAdvisory(e.score, e.advisory, displayLabel);
        return;
      }

      case 'post.aligned': {
        if (this.opts.verbose) {
          this.flush();
          const displayLabel = e.agent?.displayName ?? e.label;
          printPostAligned(e.summary, displayLabel, e.score);
        } else {
          this.suppressed++;
        }
        return;
      }

      case 'post.misaligned': {
        this.flush();
        const displayLabel = e.agent?.displayName ?? e.label;
        printPostMisaligned(e.advisory, displayLabel);
        return;
      }

      case 'session.connected': {
        this.flush();
        // Show agent displayName in the connected line when available
        const displayLabel = e.agent?.displayName ?? e.label;
        printSessionStart(displayLabel, e.sessionId);
        return;
      }

      case 'banner':
        printBanner(e.port);
        return;

      case 'warning':
        printWarning(e.message);
        return;

      case 'error':
        printError(e.message);
        return;

      case 'debug':
        printDebug(e.label, e.body);
        return;

      default:
        assertNever(e);
    }
  }

  /** Print suppressed-event count (if any) and reset the counter. */
  private flush(): void {
    if (this.suppressed > 0) {
      printSuppressedCount(this.suppressed);
      this.suppressed = 0;
    }
  }
}
