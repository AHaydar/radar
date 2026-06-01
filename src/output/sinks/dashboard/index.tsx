import React from 'react';
import { render } from 'ink';
import type { Sink } from '../../sink.js';
import type { RadarEvent } from '../../events.js';
import type { Action } from './store.js';
import { Dashboard } from './Dashboard.js';

export class DashboardSink implements Sink {
  private unmount: (() => void) | null = null;
  private dispatch: ((action: Action) => void) | null = null;

  // Track promptId per label for correlating pre/post events within a turn
  private readonly activePrompts = new Map<string, string>();
  private promptCounter = 0;
  // Map session label (S1, S2…) → real sessionId so pre/post events
  // route to the same store record that session.connected created.
  private readonly labelToSessionId = new Map<string, string>();

  mount(onExit?: () => void): void {
    // Enter alt-screen — preserves the scroll buffer so exiting the dashboard
    // restores the terminal exactly as it was (htop/vim UX).
    process.stdout.write('\x1b[?1049h');
    try {
      const { unmount } = render(
        <Dashboard
          onDispatchReady={(d) => {
            this.dispatch = d;
          }}
          onExit={onExit}
        />,
      );
      this.unmount = unmount;
    } catch (err) {
      // render() failed — exit alt-screen before re-throwing
      process.stdout.write('\x1b[?1049l');
      throw err;
    }
  }

  emit(e: RadarEvent): void {
    if (!this.dispatch) return;

    switch (e.type) {
      case 'session.connected': {
        // Store label→sessionId mapping so pre/post events can route correctly
        this.labelToSessionId.set(e.label, e.sessionId);
        this.dispatch({
          type: 'session_connected',
          sessionId: e.sessionId,
          label: e.label,
          agentName: e.agent?.name,
          agentDisplayName: e.agent?.displayName,
        });
        return;
      }

      case 'pre.clear': {
        if (!e.label) return;
        const sessionId = this.labelToSessionId.get(e.label) ?? e.label;
        const promptId = this._getOrCreatePromptId(e.label);
        this.dispatch({
          type: 'pre_clear',
          sessionId,
          promptId,
          score: e.score,
        });
        return;
      }

      case 'pre.advisory': {
        if (!e.label) return;
        const sessionId = this.labelToSessionId.get(e.label) ?? e.label;
        const promptId = this._getOrCreatePromptId(e.label);
        this.dispatch({
          type: 'pre_advisory',
          sessionId,
          promptId,
          score: e.score,
          advisory: e.advisory,
        });
        return;
      }

      case 'post.aligned': {
        if (!e.label) return;
        const sessionId = this.labelToSessionId.get(e.label) ?? e.label;
        const promptId = this._getOrCreatePromptId(e.label);
        this.dispatch({
          type: 'post_aligned',
          sessionId,
          promptId,
          summary: e.summary,
        });
        this._clearPromptId(e.label);
        return;
      }

      case 'post.misaligned': {
        if (!e.label) return;
        const sessionId = this.labelToSessionId.get(e.label) ?? e.label;
        const promptId = this._getOrCreatePromptId(e.label);
        this.dispatch({
          type: 'post_misaligned',
          sessionId,
          promptId,
          advisory: e.advisory,
        });
        this._clearPromptId(e.label);
        return;
      }

      // Events we ignore in the dashboard:
      case 'banner':
      case 'warning':
      case 'error':
      case 'debug':
        return;

      default:
        return;
    }
  }

  close(): void {
    this.unmount?.();
    this.unmount = null;
    this.dispatch = null;
    // Exit alt-screen — restores the scroll buffer from before mount() was called
    process.stdout.write('\x1b[?1049l');
  }

  private _getOrCreatePromptId(sessionLabel: string): string {
    if (!this.activePrompts.has(sessionLabel)) {
      this.activePrompts.set(sessionLabel, `p${++this.promptCounter}`);
    }
    return this.activePrompts.get(sessionLabel)!;
  }

  private _clearPromptId(sessionLabel: string): void {
    this.activePrompts.delete(sessionLabel);
  }
}
