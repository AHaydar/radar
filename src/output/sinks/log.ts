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
 */
export class LogSink implements Sink {
  private suppressed = 0;

  constructor(private readonly opts: { verbose: boolean }) {}

  emit(e: RadarEvent): void {
    switch (e.type) {
      case 'pre.clear':
        if (this.opts.verbose) {
          this.flush();
          printPreClear(e.score, e.label);
        } else {
          this.suppressed++;
        }
        return;

      case 'pre.advisory':
        this.flush();
        printPreAdvisory(e.score, e.advisory, e.label);
        return;

      case 'post.aligned':
        if (this.opts.verbose) {
          this.flush();
          printPostAligned(e.summary, e.label, e.score);
        } else {
          this.suppressed++;
        }
        return;

      case 'post.misaligned':
        this.flush();
        printPostMisaligned(e.advisory, e.label);
        return;

      case 'session.connected':
        this.flush();
        printSessionStart(e.label, e.sessionId);
        return;

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
