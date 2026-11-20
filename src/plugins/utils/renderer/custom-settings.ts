/**
 * One on-screen settings modal for all of our custom plugins.
 *
 * Toggle it with Cmd+Shift+. (Ctrl+Shift+. on Windows/Linux). Each plugin
 * adds its own section with `registerSettingsSection()` when it starts and
 * removes it when it stops, so the modal shows every enabled custom plugin.
 * The `create*` helpers build controls with a shared look.
 */
import { t } from '@/i18n';

export interface SettingsSection {
  id: string;
  title: () => string;
  /** Build the section's controls into `container`. */
  render: (container: HTMLElement) => void;
}

const sections = new Map<string, SettingsSection>();
let host: HTMLElement | undefined;
let shortcutInstalled = false;

const isToggleShortcut = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) &&
  event.shiftKey &&
  !event.altKey &&
  event.code === 'Period';

const onShortcut = (event: KeyboardEvent) => {
  if (!isToggleShortcut(event)) return;
  event.preventDefault();
  event.stopPropagation();
  toggleSettingsModal();
};

export const registerSettingsSection = (section: SettingsSection) => {
  sections.set(section.id, section);
  if (!shortcutInstalled) {
    window.addEventListener('keydown', onShortcut, true);
    shortcutInstalled = true;
  }
  if (host) renderModal();
  return () => {
    sections.delete(section.id);
    if (host) renderModal();
    if (sections.size === 0) {
      closeSettingsModal();
      window.removeEventListener('keydown', onShortcut, true);
      shortcutInstalled = false;
    }
  };
};

export const toggleSettingsModal = () =>
  host ? closeSettingsModal() : openSettingsModal();

export const closeSettingsModal = () => {
  host?.remove();
  host = undefined;
};

export const openSettingsModal = () => {
  if (host) return;
  host = document.createElement('custom-settings-modal');
  const shadow = host.attachShadow({ mode: 'open' });
  // Keep YouTube Music's keyboard shortcuts (space, digits, …) from firing
  // while typing in the modal.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    host.addEventListener(type, (event) => {
      if (type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
        closeSettingsModal();
      }
      event.stopPropagation();
    });
  }
  shadow.innerHTML = `<style>${styles}</style>`;
  document.body.append(host);
  renderModal();
};

const renderModal = () => {
  const shadow = host?.shadowRoot;
  if (!shadow) return;
  shadow.querySelector('.backdrop')?.remove();

  const backdrop = el('div', 'backdrop');
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeSettingsModal();
  });

  const dialog = el('div', 'dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = el('div', 'header');
  const title = el('h2', 'title', t('custom-settings.title'));
  const close = el('button', 'close', '✕');
  close.setAttribute('aria-label', t('custom-settings.close'));
  close.addEventListener('click', closeSettingsModal);
  header.append(title, close);

  const body = el('div', 'body');
  if (sections.size === 0) {
    body.append(el('p', 'empty', t('custom-settings.empty')));
  }
  for (const section of sections.values()) {
    const block = el('section', 'section');
    block.append(el('h3', 'section-title', section.title()));
    const content = el('div', 'section-content');
    section.render(content);
    block.append(content);
    body.append(block);
  }

  const footer = el('div', 'footer', t('custom-settings.hint'));

  dialog.append(header, body, footer);
  backdrop.append(dialog);
  shadow.append(backdrop);
  close.focus();
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A labelled on/off switch. */
export const createToggle = (options: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const row = el('label', 'row toggle-row');
  const text = el('span', 'label', options.label);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch';
  input.checked = options.checked;
  input.addEventListener('change', () => options.onChange(input.checked));
  row.append(text, input);
  return { row, input };
};

/** A slider with a number box next to it, kept in sync. */
export const createSlider = (options: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) => {
  const row = el('div', 'row slider-row');
  const text = el('span', 'label', options.label);
  const controls = el('div', 'slider-controls');

  const range = document.createElement('input');
  range.type = 'range';
  const number = document.createElement('input');
  number.type = 'number';
  for (const input of [range, number]) {
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);
  }
  number.className = 'number';
  const unit = el('span', 'unit', options.unit ?? '');

  const commit = (raw: string, source: HTMLInputElement) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const value = Math.min(options.max, Math.max(options.min, parsed));
    if (source !== range) range.value = String(value);
    if (source !== number) number.value = String(value);
    options.onChange(value);
  };
  range.addEventListener('input', () => commit(range.value, range));
  number.addEventListener('change', () => {
    commit(number.value, number);
    number.value = range.value;
  });

  controls.append(range, number, unit);
  row.append(text, controls);
  return {
    row,
    setDisabled(disabled: boolean) {
      range.disabled = disabled;
      number.disabled = disabled;
      row.classList.toggle('disabled', disabled);
    },
  };
};

/** A row of mutually exclusive buttons. */
export const createChoice = <T extends string>(options: {
  label: string;
  value: T;
  choices: { value: T; label: string }[];
  onChange: (value: T) => void;
}) => {
  const row = el('div', 'row choice-row');
  const text = el('span', 'label', options.label);
  const group = el('div', 'choices');
  group.setAttribute('role', 'radiogroup');

  const buttons = options.choices.map((choice) => {
    const button = el('button', 'choice', choice.label);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    const select = () => {
      for (const other of buttons) {
        other.setAttribute('aria-checked', String(other === button));
      }
      options.onChange(choice.value);
    };
    button.setAttribute('aria-checked', String(choice.value === options.value));
    button.addEventListener('click', select);
    return button;
  });

  group.append(...buttons);
  row.append(text, group);
  return { row };
};

const styles = `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    font-family: Roboto, 'Helvetica Neue', Arial, sans-serif;
    --bg: #212121;
    --surface: #2c2c2c;
    --border: rgba(255, 255, 255, 0.12);
    --text: #fff;
    --muted: rgba(255, 255, 255, 0.64);
    --accent: #ff4e45;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 16px;
  }
  .dialog {
    width: min(520px, 100%);
    /* Fits any window: at most 720px, else the window less a margin. */
    max-height: min(720px, calc(100vh - 32px));
    max-height: min(720px, calc(100dvh - 32px));
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .title { margin: 0; font-size: 18px; font-weight: 500; }
  .close {
    all: unset;
    cursor: pointer;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--muted);
    font-size: 16px;
  }
  .close:hover, .close:focus-visible { background: var(--surface); color: var(--text); }
  /* Scrolls (a flex child only shrinks below its content with min-height 0). */
  .body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 8px 20px 16px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  @media (max-height: 480px) {
    .backdrop { padding: 8px; }
    .dialog { max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); }
    .header { padding: 10px 16px; }
  }
  .section { padding: 12px 0; }
  .section + .section { border-top: 1px solid var(--border); }
  .section-title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 44px;
  }
  .label { font-size: 14px; }
  .toggle-row { cursor: pointer; }
  .switch {
    appearance: none;
    flex: none;
    width: 36px;
    height: 20px;
    margin: 0;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.3);
    position: relative;
    cursor: pointer;
    transition: background 0.15s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { transform: translateX(16px); }
  .slider-controls { display: flex; align-items: center; gap: 8px; }
  input[type='range'] { width: 160px; accent-color: var(--accent); }
  .number {
    width: 56px;
    padding: 4px 6px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
  }
  .unit { font-size: 13px; color: var(--muted); min-width: 10px; }
  .disabled { opacity: 0.45; }
  .choices {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 2px;
  }
  .choice {
    all: unset;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  .choice[aria-checked='true'] { background: var(--accent); color: #fff; }
  .choice:focus-visible, .switch:focus-visible, input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .empty { color: var(--muted); font-size: 14px; }
  .footer {
    padding: 10px 20px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }
  @media (max-width: 480px) {
    .row { flex-wrap: wrap; }
    input[type='range'] { width: 120px; }
  }
`;
