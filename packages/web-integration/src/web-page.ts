import type { Point } from '@midscene/core';
import { z } from '@midscene/core';
import {
  AbstractInterface,
  type BrowserInputPrimitives,
  type DeviceAction,
  type InputStrategy,
  defineAction,
  defineActionsFromInputPrimitives,
  resolveTextInputOptions,
  sendTextSequentially,
} from '@midscene/core/device';
import { TreeOnlyOperationError } from '@midscene/core/tree-only';

import { sleep } from '@midscene/core/utils';
import type { ElementInfo } from '@midscene/shared/extractor';
import { transformHotkeyInput } from '@midscene/shared/us-keyboard-layout';

const navigateParamSchema = z.object({
  url: z
    .string()
    .describe(
      'The URL to navigate to. Must start with https://, file://, or a similar protocol.',
    ),
});

function normalizeKeyInputs(value: string | string[]): string[] {
  const inputs = Array.isArray(value) ? value : [value];
  const result: string[] = [];

  for (const input of inputs) {
    if (typeof input !== 'string') {
      result.push(input as unknown as string);
      continue;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      result.push(input);
      continue;
    }

    let normalized = trimmed;
    if (normalized.length > 1 && normalized.includes('+')) {
      normalized = normalized.replace(/\s*\+\s*/g, ' ');
    }
    if (/\s/.test(normalized)) {
      normalized = normalized.replace(/\s+/g, ' ');
    }

    const transformed = transformHotkeyInput(normalized);
    if (transformed.length === 1 && transformed[0] === '' && trimmed !== '') {
      result.push(input);
      continue;
    }
    if (transformed.length === 0) {
      result.push(input);
      continue;
    }

    result.push(...transformed);
  }

  return result;
}

export function getKeyCommands(
  value: string | string[],
): Array<{ key: string; command?: string }> {
  const keys = normalizeKeyInputs(value);

  return keys.reduce((acc: Array<{ key: string; command?: string }>, k) => {
    const includeMeta = keys.includes('Meta') || keys.includes('Control');
    if (includeMeta && (k === 'a' || k === 'A')) {
      return acc.concat([{ key: k, command: 'SelectAll' }]);
    }
    if (includeMeta && (k === 'c' || k === 'C')) {
      return acc.concat([{ key: k, command: 'Copy' }]);
    }
    if (includeMeta && (k === 'v' || k === 'V')) {
      return acc.concat([{ key: k, command: 'Paste' }]);
    }
    return acc.concat([{ key: k }]);
  }, []);
}

// this is copied from puppeteer, but we don't want to import puppeteer here
export declare type KeyInput =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'Power'
  | 'Eject'
  | 'Abort'
  | 'Help'
  | 'Backspace'
  | 'Tab'
  | 'Numpad5'
  | 'NumpadEnter'
  | 'Enter'
  | '\r'
  | '\n'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'ControlLeft'
  | 'ControlRight'
  | 'AltLeft'
  | 'AltRight'
  | 'Pause'
  | 'CapsLock'
  | 'Escape'
  | 'Convert'
  | 'NonConvert'
  | 'Space'
  | 'Numpad9'
  | 'PageUp'
  | 'Numpad3'
  | 'PageDown'
  | 'End'
  | 'Numpad1'
  | 'Home'
  | 'Numpad7'
  | 'ArrowLeft'
  | 'Numpad4'
  | 'Numpad8'
  | 'ArrowUp'
  | 'ArrowRight'
  | 'Numpad6'
  | 'Numpad2'
  | 'ArrowDown'
  | 'Select'
  | 'Open'
  | 'PrintScreen'
  | 'Insert'
  | 'Numpad0'
  | 'Delete'
  | 'NumpadDecimal'
  | 'Digit0'
  | 'Digit1'
  | 'Digit2'
  | 'Digit3'
  | 'Digit4'
  | 'Digit5'
  | 'Digit6'
  | 'Digit7'
  | 'Digit8'
  | 'Digit9'
  | 'KeyA'
  | 'KeyB'
  | 'KeyC'
  | 'KeyD'
  | 'KeyE'
  | 'KeyF'
  | 'KeyG'
  | 'KeyH'
  | 'KeyI'
  | 'KeyJ'
  | 'KeyK'
  | 'KeyL'
  | 'KeyM'
  | 'KeyN'
  | 'KeyO'
  | 'KeyP'
  | 'KeyQ'
  | 'KeyR'
  | 'KeyS'
  | 'KeyT'
  | 'KeyU'
  | 'KeyV'
  | 'KeyW'
  | 'KeyX'
  | 'KeyY'
  | 'KeyZ'
  | 'MetaLeft'
  | 'MetaRight'
  | 'ContextMenu'
  | 'NumpadMultiply'
  | 'NumpadAdd'
  | 'NumpadSubtract'
  | 'NumpadDivide'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'F13'
  | 'F14'
  | 'F15'
  | 'F16'
  | 'F17'
  | 'F18'
  | 'F19'
  | 'F20'
  | 'F21'
  | 'F22'
  | 'F23'
  | 'F24'
  | 'NumLock'
  | 'ScrollLock'
  | 'AudioVolumeMute'
  | 'AudioVolumeDown'
  | 'AudioVolumeUp'
  | 'MediaTrackNext'
  | 'MediaTrackPrevious'
  | 'MediaStop'
  | 'MediaPlayPause'
  | 'Semicolon'
  | 'Equal'
  | 'NumpadEqual'
  | 'Comma'
  | 'Minus'
  | 'Period'
  | 'Slash'
  | 'Backquote'
  | 'BracketLeft'
  | 'Backslash'
  | 'BracketRight'
  | 'Quote'
  | 'AltGraph'
  | 'Props'
  | 'Cancel'
  | 'Clear'
  | 'Shift'
  | 'Control'
  | 'Alt'
  | 'Accept'
  | 'ModeChange'
  | ' '
  | 'Print'
  | 'Execute'
  | '\u0000'
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | 'Meta'
  | '*'
  | '+'
  | '-'
  | '/'
  | ';'
  | '='
  | ','
  | '.'
  | '`'
  | '['
  | '\\'
  | ']'
  | "'"
  | 'Attn'
  | 'CrSel'
  | 'ExSel'
  | 'EraseEof'
  | 'Play'
  | 'ZoomOut'
  | ')'
  | '!'
  | '@'
  | '#'
  | '$'
  | '%'
  | '^'
  | '&'
  | '('
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | ':'
  | '<'
  | '_'
  | '>'
  | '?'
  | '~'
  | '{'
  | '|'
  | '}'
  | '"'
  | 'SoftLeft'
  | 'SoftRight'
  | 'Camera'
  | 'Call'
  | 'EndCall'
  | 'VolumeDown'
  | 'VolumeUp';

export type MouseButton = 'left' | 'right' | 'middle';

export interface MouseAction {
  click: (
    x: number,
    y: number,
    options: { button: MouseButton; count?: number },
  ) => Promise<void>;
  wheel: (deltaX: number, deltaY: number) => Promise<void>;
  move: (x: number, y: number) => Promise<void>;
  drag: (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => Promise<void>;
}

export interface KeyboardAction {
  type: (text: string, options?: { delay?: number }) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  press: (
    action:
      | { key: KeyInput; command?: string }
      | { key: KeyInput; command?: string }[],
  ) => Promise<void>;
}

export interface ChromePageDestroyOptions {
  closeTab?: boolean; // should close the tab when the page object is destroyed
}

/** Live facts about the input/textarea under a locate target. */
export interface WebInputControl {
  tagName: 'input' | 'textarea';
  /** `input.type` for inputs; empty for textareas. */
  type: string;
  value: string;
  readOnly: boolean;
}

/** Locate-point coordinates of an input target. */
export interface WebInputTarget {
  center?: [number, number];
}

export abstract class AbstractWebPage extends AbstractInterface {
  readonly keyboardTypeDelay?: number;
  readonly inputStrategy?: InputStrategy;
  navigate?(url: string): Promise<void>;
  reload?(): Promise<void>;
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
  stopLoading?(): Promise<void>;
  navigationState?(): Promise<{ isLoading: boolean }>;
  flushPendingVisualUpdate?(force?: boolean): Promise<void>;
  schedulePendingVisualUpdate?(force?: boolean): void;
  waitForDomQuiet?(opts?: {
    quietMs?: number;
    timeoutMs?: number;
    target?: ElementInfo;
  }): Promise<void>;

  get mouse(): MouseAction {
    return {
      click: async (
        x: number,
        y: number,
        options: { button: MouseButton },
      ) => {},
      wheel: async (deltaX: number, deltaY: number) => {},
      move: async (x: number, y: number) => {},
      drag: async (
        from: { x: number; y: number },
        to: { x: number; y: number },
      ) => {},
    };
  }

  get keyboard(): KeyboardAction {
    return {
      type: async (text: string, options?: { delay?: number }) => {},
      insertText: async (text: string) => {},
      press: async (
        action:
          | { key: KeyInput; command?: string }
          | { key: KeyInput; command?: string }[],
      ) => {},
    };
  }

  async clearInput(element?: ElementInfo): Promise<void> {}

  async selectAllInput(element?: ElementInfo): Promise<void> {
    throw new Error('Bulk text input is not supported by this web page');
  }

  /**
   * Read the live control at a locate point, if any. Platforms that support
   * value verification and native temporal inputs implement this; callers
   * treat it as optional so mocked pages keep working.
   */
  readInputControl?(
    target?: WebInputTarget,
  ): Promise<WebInputControl | undefined>;

  /**
   * Enter a value into the control at a locate point through the native value
   * setter plus input/change events. Used for inputs whose value Chromium
   * does not accept from synthetic key events (date, time, month, week).
   * Returns whether a control was found and updated.
   */
  setInputValue?(target?: WebInputTarget, value?: string): Promise<boolean>;

  abstract scrollUntilTop(startingPoint?: Point): Promise<void>;
  abstract scrollUntilBottom(startingPoint?: Point): Promise<void>;
  abstract scrollUntilLeft(startingPoint?: Point): Promise<void>;
  abstract scrollUntilRight(startingPoint?: Point): Promise<void>;
  abstract scrollUp(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollDown(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollLeft(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollRight(distance?: number, startingPoint?: Point): Promise<void>;
  abstract longPress(x: number, y: number, duration?: number): Promise<void>;
  abstract swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration?: number,
  ): Promise<void>;
  abstract pinch(
    centerX: number,
    centerY: number,
    startDistance: number,
    endDistance: number,
    duration?: number,
  ): Promise<void>;
}

const scheduleWebVisualUpdate = (
  page: AbstractWebPage,
  force = false,
): void => {
  if (page.schedulePendingVisualUpdate) {
    if (force) {
      page.schedulePendingVisualUpdate(true);
    } else {
      page.schedulePendingVisualUpdate();
    }
    return;
  }

  const pendingRefresh = force
    ? page.flushPendingVisualUpdate?.(true)
    : page.flushPendingVisualUpdate?.();
  void pendingRefresh?.catch(() => undefined);
};

/**
 * Native temporal inputs cannot be filled with synthetic key events in
 * Chromium: the key events reach the browser but never update the value.
 * Their value must be assigned through the native setter and announced with
 * input/change events so frameworks observe the entry.
 */
const TEMPORAL_INPUT_TYPES = new Set([
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/**
 * Input types whose `value` is the verbatim entered text. Types that
 * normalize, sanitize, or mask their value (`number` formats, `email`/`url`
 * strip surrounding whitespace) are not verified: a readback difference
 * there is not proof that entry failed.
 */
const VERBATIM_INPUT_TYPES = new Set([
  'text',
  'search',
  'tel',
  'password',
  ...TEMPORAL_INPUT_TYPES,
]);

function verifiableInputControl(control: WebInputControl): boolean {
  return (
    control.tagName === 'textarea' || VERBATIM_INPUT_TYPES.has(control.type)
  );
}

/**
 * Read a control without letting an unreadable page replace the existing
 * typing behavior: verification and temporal-input fill are enhancements,
 * so a failed read means "cannot verify", not "entry failed".
 */
async function readInputControlSafely(
  page: AbstractWebPage,
  target: unknown,
): Promise<WebInputControl | undefined> {
  if (!page.readInputControl) {
    return undefined;
  }
  try {
    return await page.readInputControl(target as WebInputTarget);
  } catch {
    return undefined;
  }
}

/**
 * Verify entered text by reading the live control back. A returned typing
 * call is not proof of entry: a control can reject the value or re-render
 * without it. Reads are inspection only, never a re-dispatch. A mismatch is
 * reported as an `unsupported-input` TreeOnlyOperationError so the execution
 * outcome contract can treat it as a permanent input failure; visual callers
 * see the same hard failure.
 */
async function verifyEnteredInputValue(
  page: AbstractWebPage,
  target: unknown,
  expected: string,
  initial: WebInputControl,
): Promise<void> {
  if (!page.readInputControl || !verifiableInputControl(initial)) {
    return;
  }
  let lastValue = initial.value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const control = await readInputControlSafely(page, target);
    if (!control || !verifiableInputControl(control)) {
      return;
    }
    lastValue = control.value;
    if (control.value === expected) {
      return;
    }
    if (attempt < 2) {
      await sleep(100);
    }
  }
  const subject =
    `the ${initial.tagName}` +
    `${initial.type ? `[type=${initial.type}]` : ''} control`;
  // Never echo credential values into errors, reports, or logs.
  const detail =
    initial.type === 'password'
      ? `read back ${lastValue ? 'a different value' : 'an empty value'}`
      : `expected ${JSON.stringify(expected)}, read back ${JSON.stringify(lastValue)}`;
  throw new TreeOnlyOperationError(
    `Input value was not retained by ${subject}: ${detail}`,
    'unsupported-input',
  );
}

export function createWebInputPrimitives(
  page: AbstractWebPage,
): BrowserInputPrimitives {
  const scheduleVisualUpdate = () => scheduleWebVisualUpdate(page);

  return {
    pointer: {
      tap: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'left' });
        scheduleVisualUpdate();
      },
      rightClick: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'right' });
        scheduleVisualUpdate();
      },
      doubleClick: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'left', count: 2 });
        scheduleVisualUpdate();
      },
      hover: async ({ x, y }) => {
        await page.mouse.move(x, y);
        scheduleVisualUpdate();
      },
      dragAndDrop: async (from, to) => {
        await page.mouse.drag(from, to);
        scheduleVisualUpdate();
      },
      longPress: async ({ x, y }, opts) => {
        await page.longPress(x, y, opts?.duration);
        scheduleVisualUpdate();
      },
    },
    keyboard: {
      typeText: async (value, opts) => {
        const element = opts?.target;
        const { inputStrategy, keyboardTypeDelay } = resolveTextInputOptions(
          opts,
          page,
        );
        // Read the live control before touching it: native temporal inputs
        // reject synthetic key events and every entry is read back after.
        const control =
          element && !opts?.focusOnly
            ? await readInputControlSafely(page, element)
            : undefined;
        // Temporal controls have no cursor to insert at, so replace and
        // typeOnly both enter the requested value directly.
        if (
          element &&
          control &&
          control.tagName === 'input' &&
          TEMPORAL_INPUT_TYPES.has(control.type) &&
          page.setInputValue
        ) {
          const applied = await page.setInputValue(
            element as WebInputTarget,
            value,
          );
          if (applied) {
            await verifyEnteredInputValue(page, element, value, control);
            scheduleVisualUpdate();
            return;
          }
        }
        if (element && opts?.replace !== false) {
          if (inputStrategy === 'bulk') {
            // Keep the current value selected so insertText replaces it in one
            // input operation instead of emitting a separate empty value.
            await page.selectAllInput(element as ElementInfo);
          } else {
            await page.clearInput(element as ElementInfo);
            // Frameworks (React/Vue/etc.) often re-render in response to
            // the `input` event fired by clearing. If that re-render lands
            // between clearInput returning and the first typed character,
            // the keypresses can be dropped. Wait for the DOM to settle
            // before starting to type.
            await page.waitForDomQuiet?.({ target: element as ElementInfo });
          }
        } else if (element && opts?.focusOnly) {
          const target = element as ElementInfo;
          await page.mouse.click(target.center[0], target.center[1], {
            button: 'left',
          });
          await page.keyboard.press([{ key: 'End' }]);
        }

        if (opts?.focusOnly) {
          return;
        }

        if (inputStrategy === 'bulk') {
          await page.keyboard.insertText(value);
        } else if (inputStrategy === 'sequential') {
          await sendTextSequentially(
            value,
            {
              // The shared loop owns the inter-character delay. Explicitly
              // disable the page default so action-level zero remains
              // effective and positive delays are not applied twice.
              sendCharacter: (character) =>
                page.keyboard.type(character, { delay: 0 }),
              wait: sleep,
            },
            { delayMs: keyboardTypeDelay },
          );
        } else {
          const keyboardTypeOptions =
            keyboardTypeDelay === undefined
              ? undefined
              : { delay: keyboardTypeDelay };
          await page.keyboard.type(value, keyboardTypeOptions);
        }
        // `typeOnly` inserts at the cursor, so the resulting value depends on
        // the prior state and cannot be compared to the requested text.
        if (element && control && opts?.replace !== false) {
          await verifyEnteredInputValue(page, element, value, control);
        }
        scheduleVisualUpdate();
      },
      keyboardPress: async (keyName, opts) => {
        const element = opts?.target as
          | { center: [number, number] }
          | undefined;
        if (element) {
          await page.mouse.click(element.center[0], element.center[1], {
            button: 'left',
          });
        }

        const keys = getKeyCommands(keyName);
        await page.keyboard.press(keys as any);
        scheduleVisualUpdate();
      },
      cursorMove: async (direction, times = 1) => {
        const arrowKey = direction === 'left' ? 'ArrowLeft' : 'ArrowRight';
        for (let i = 0; i < times; i++) {
          await page.keyboard.press([{ key: arrowKey as any }]);
          await sleep(100);
        }
      },
      clearInput: async (target) => {
        await page.clearInput(target as ElementInfo | undefined);
      },
    },
    touch: {
      pinch: async ({ x, y }, opts) => {
        await page.pinch(
          x,
          y,
          opts.startDistance,
          opts.endDistance,
          opts.duration,
        );
      },
      swipe: async (from, to, opts) => {
        await page.swipe(from, to, opts?.duration);
      },
    },
    scroll: {
      scroll: async (param) => {
        const element = param.locate;
        const startingPoint = element
          ? {
              left: element.center[0],
              top: element.center[1],
            }
          : undefined;
        const scrollToEventName = param?.scrollType;
        if (scrollToEventName === 'scrollToTop') {
          await page.scrollUntilTop(startingPoint);
        } else if (scrollToEventName === 'scrollToBottom') {
          await page.scrollUntilBottom(startingPoint);
        } else if (scrollToEventName === 'scrollToRight') {
          await page.scrollUntilRight(startingPoint);
        } else if (scrollToEventName === 'scrollToLeft') {
          await page.scrollUntilLeft(startingPoint);
        } else if (scrollToEventName === 'singleAction' || !scrollToEventName) {
          if (param?.direction === 'down' || !param || !param.direction) {
            await page.scrollDown(param?.distance || undefined, startingPoint);
          } else if (param.direction === 'up') {
            await page.scrollUp(param.distance || undefined, startingPoint);
          } else if (param.direction === 'left') {
            await page.scrollLeft(param.distance || undefined, startingPoint);
          } else if (param.direction === 'right') {
            await page.scrollRight(param.distance || undefined, startingPoint);
          } else {
            throw new Error(`Unknown scroll direction: ${param.direction}`);
          }
          await sleep(500);
        } else {
          throw new Error(
            `Unknown scroll event type: ${scrollToEventName}, param: ${JSON.stringify(
              param,
            )}`,
          );
        }
        scheduleVisualUpdate();
      },
    },
  };
}

export const commonWebActionsForWebPage = <T extends AbstractWebPage>(
  page: T,
  includeTouchEvents = false,
): DeviceAction<any>[] => {
  const input = createWebInputPrimitives(page);
  return [
    ...defineActionsFromInputPrimitives(input, {
      size: () => page.size(),
      includeSwipe: includeTouchEvents,
    }),

    defineAction<typeof navigateParamSchema, { url: string }>({
      name: 'Navigate',
      description:
        'Navigate the browser to a specified URL. Opens the URL in the current tab.',
      paramSchema: navigateParamSchema,
      sample: {
        url: 'https://www.example.com',
      },
      call: async (param) => {
        if (!page.navigate) {
          throw new Error(
            'Navigate operation is not supported on this page type',
          );
        }
        await page.navigate(param.url);
        scheduleWebVisualUpdate(page, true);
      },
    }),

    defineAction({
      name: 'Reload',
      description: 'Reload the current page',
      call: async () => {
        if (!page.reload) {
          throw new Error(
            'Reload operation is not supported on this page type',
          );
        }
        await page.reload();
        scheduleWebVisualUpdate(page, true);
      },
    }),

    defineAction({
      name: 'GoBack',
      description: 'Navigate back in browser history',
      call: async () => {
        if (!page.goBack) {
          throw new Error(
            'GoBack operation is not supported on this page type',
          );
        }
        await page.goBack();
        scheduleWebVisualUpdate(page, true);
      },
    }),
    defineAction({
      name: 'GoForward',
      description: 'Navigate forward in browser history',
      call: async () => {
        if (!page.goForward) {
          throw new Error(
            'GoForward operation is not supported on this page type',
          );
        }
        await page.goForward();
        scheduleWebVisualUpdate(page, true);
      },
    }),
  ];
};
