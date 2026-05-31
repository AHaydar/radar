/**
 * Central keybinding table for the dashboard.
 * Maps Ink useInput key properties to action names.
 */

export type DashboardAction =
  | 'nav_up'
  | 'nav_down'
  | 'nav_left'
  | 'nav_right'
  | 'toggle_expand'
  | 'copy_advisory'
  | 'exit'
  | 'help';

export interface KeyBinding {
  action: DashboardAction;
  description: string;
  hint: string;
}

export const KEY_BINDINGS: KeyBinding[] = [
  { action: 'nav_up',        description: 'Move focus up in session list',        hint: '↑' },
  { action: 'nav_down',      description: 'Move focus down in session list',       hint: '↓' },
  { action: 'nav_left',      description: 'Move to previous turn in detail panel', hint: '←' },
  { action: 'nav_right',     description: 'Move to next turn in detail panel',     hint: '→' },
  { action: 'toggle_expand', description: 'Toggle expanded view of focused turn',  hint: 'enter' },
  { action: 'copy_advisory', description: "Copy focused turn's advisory",          hint: 'c' },
  { action: 'exit',          description: 'Exit dashboard, restore scroll',        hint: 'q/ctrl-g' },
  { action: 'help',          description: 'Show help overlay',                     hint: '?' },
];

export const HINT_LINE = KEY_BINDINGS
  .filter((b) => b.action !== 'help')
  .map((b) => `${b.hint} ${b.description.split(' ').slice(0, 2).join(' ')}`)
  .join(' · ');
