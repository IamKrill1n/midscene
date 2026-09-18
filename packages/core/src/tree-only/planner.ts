import type { StandardPlanningProtocol } from '@/ai-model/model-adapter/planning-protocol';
import type { ModelRuntime } from '@/ai-model/models';
import { callAI } from '@/ai-model/service-caller';
import { normalizePlanningActionLocateFields } from '@/ai-model/workflows/planning/locate-normalization';
import { parseStandardPlanningResponse } from '@/ai-model/workflows/planning/standard-planning-parser';
import type { DeviceAction, PlanningAction } from '@/types';
import type {
  TreeOnlyBrowserNode,
  TreeOnlyCoverageGap,
} from '@midscene/shared/tree-only';
import {
  buildTreeOnlyPlannerUserMessage,
  buildTreeOnlyPlanningSystemPrompt,
} from './planner-prompt';
import { TreeOnlyOperationError } from './types';

/**
 * T2 tree-only planner.
 *
 * Midscene's standard planner is adapted here to tree/text evidence: the
 * action output protocol and parser stay the same, but the observation is a
 * JSON UI tree and locate fields stay textual so Jev can select the observed
 * target. The planner is image-free by construction; coordinate or
 * locatedPixelResult output from the model is stripped before it can reach
 * execution.
 */

/** The only actions the tree-only planner may choose. */
export const TREE_ONLY_PLANNER_ACTION_NAMES = [
  'Tap',
  'Input',
  'Scroll',
] as const;

export interface TreeOnlyPlannerHistoryEntry {
  operation: string;
  target?: string;
  value?: string;
  outcome: string;
}

export interface TreeOnlyPlannerElement extends TreeOnlyBrowserNode {
  supported_operations: readonly string[];
}

export interface TreeOnlyPlannerState {
  page: { url: string; title: string; text: string };
  elements: readonly TreeOnlyPlannerElement[];
  coverage: readonly TreeOnlyCoverageGap[];
  recent_actions: readonly TreeOnlyPlannerHistoryEntry[];
}

export interface TreeOnlyPlannerInput {
  /** The user's aiAct instruction, without public context merging. */
  instruction: string;
  /** Resolved public aiAct context; call context wins over agent context. */
  actionContext?: string;
  /** Revised action/operation-local context supplied by recovery (T3). */
  recoveryContext?: string;
  state: TreeOnlyPlannerState;
}

export type TreeOnlyPlannerPlan =
  | {
      operation: 'CLICK' | 'TYPE_TEXT';
      /** Textual target description for Jev; never coordinates. */
      instruction: string;
      value?: string;
      thought?: string;
      log?: string;
    }
  | {
      operation: 'SCROLL_UP' | 'SCROLL_DOWN';
      distance?: number;
      thought?: string;
      log?: string;
    };

export type TreeOnlyPlannerStop =
  | {
      operation: 'DONE';
      message?: string;
      thought?: string;
      log?: string;
    }
  | {
      operation: 'BLOCKED';
      message?: string;
      thought?: string;
      log?: string;
    };

export type TreeOnlyPlannerDecision = TreeOnlyPlannerPlan | TreeOnlyPlannerStop;

export type TreeOnlyPlanFn = (
  input: TreeOnlyPlannerInput,
) => Promise<TreeOnlyPlannerDecision>;

/** Restrict a device action space to the interactions tree-only supports. */
export function treeOnlyPlannerActionSpace(
  actionSpace: readonly DeviceAction<any>[],
): DeviceAction<any>[] {
  return actionSpace.filter((action) =>
    (TREE_ONLY_PLANNER_ACTION_NAMES as readonly string[]).includes(action.name),
  );
}

/** Map a planned tree-only interaction to its execution action and params. */
export function treeOnlyPlannerDirect(decision: TreeOnlyPlannerPlan): {
  type: 'Tap' | 'Input' | 'Scroll';
  param: Record<string, any>;
} {
  switch (decision.operation) {
    case 'CLICK':
      return { type: 'Tap', param: {} };
    case 'TYPE_TEXT':
      return {
        type: 'Input',
        param: {
          ...(decision.value !== undefined ? { value: decision.value } : {}),
        },
      };
    case 'SCROLL_UP':
    case 'SCROLL_DOWN':
      return {
        type: 'Scroll',
        param: {
          direction: decision.operation === 'SCROLL_UP' ? 'up' : 'down',
          scrollType: 'singleAction',
          ...(decision.distance !== undefined
            ? { distance: decision.distance }
            : {}),
        },
      };
  }
}

function plannerError(message: string): TreeOnlyOperationError {
  return new TreeOnlyOperationError(message, 'malformed');
}

function locatePromptOf(action: PlanningAction): string | undefined {
  const locate = action.param?.locate;
  const prompt =
    typeof locate === 'string'
      ? locate
      : locate && typeof locate === 'object'
        ? locate.prompt
        : undefined;
  return typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : undefined;
}

/**
 * Normalize one parsed planned action. `normalizePlanningActionLocateFields`
 * with `includeLocateInPlanning: false` already replaces accidental
 * coordinates with the textual prompt; this function then enforces the
 * tree-only interaction set and required parameters.
 */
function normalizePlannedAction(
  action: PlanningAction,
  context: { thought?: string; log?: string },
): TreeOnlyPlannerDecision {
  const type = action.type?.toLowerCase();
  if (type === 'tap') {
    const instruction = locatePromptOf(action);
    if (!instruction)
      throw plannerError('Tap requires a textual locate prompt');
    return { operation: 'CLICK', instruction, ...context };
  }
  if (type === 'input') {
    const instruction = locatePromptOf(action);
    if (!instruction)
      throw plannerError('Input requires a textual locate prompt');
    const rawValue = action.param?.value;
    if (
      rawValue !== undefined &&
      typeof rawValue !== 'string' &&
      typeof rawValue !== 'number'
    ) {
      throw plannerError('Input value must be a string or number');
    }
    return {
      operation: 'TYPE_TEXT',
      instruction,
      ...(rawValue !== undefined ? { value: String(rawValue) } : {}),
      ...context,
    };
  }
  if (type === 'scroll') {
    if (action.param?.locate) {
      throw new TreeOnlyOperationError(
        'Tree-only scrolling is page-level only; a locate target is not supported',
        'unsupported-input',
      );
    }
    const direction = action.param?.direction ?? 'down';
    if (direction !== 'up' && direction !== 'down') {
      throw new TreeOnlyOperationError(
        `Unsupported tree-only scroll direction: ${String(direction)}`,
        'unsupported-input',
      );
    }
    const scrollType = action.param?.scrollType ?? 'singleAction';
    if (scrollType !== 'singleAction') {
      throw new TreeOnlyOperationError(
        'Tree-only scrolling supports singleAction only',
        'unsupported-input',
      );
    }
    const distance = action.param?.distance;
    if (
      distance !== undefined &&
      distance !== null &&
      (typeof distance !== 'number' || !Number.isFinite(distance))
    ) {
      throw plannerError('Scroll distance must be a finite number');
    }
    return {
      operation: direction === 'up' ? 'SCROLL_UP' : 'SCROLL_DOWN',
      ...(typeof distance === 'number' ? { distance } : {}),
      ...context,
    };
  }
  throw new TreeOnlyOperationError(
    `Unsupported tree-only planner action: ${String(action.type)}; supported actions are ${TREE_ONLY_PLANNER_ACTION_NAMES.join(', ')}`,
    'unsupported-operation',
  );
}

/** Parse a model planning response into a tree-only planner decision. */
export function parseTreeOnlyPlannerDecision(
  content: string,
  options: {
    actionSpace: DeviceAction<any>[];
    planningProtocol: StandardPlanningProtocol;
  },
): TreeOnlyPlannerDecision {
  const { actionSpace, planningProtocol } = options;
  const parsed = parseStandardPlanningResponse(content, {
    includeThought: true,
    actionOutputProtocol: planningProtocol.actionOutputProtocol,
    actionSpace,
    logSource: 'model',
  });
  const context = {
    ...(parsed.thought ? { thought: parsed.thought } : {}),
    ...(parsed.log ? { log: parsed.log } : {}),
  };
  if (parsed.error) {
    return { operation: 'BLOCKED', message: parsed.error, ...context };
  }
  if (parsed.action) {
    const actions = [parsed.action];
    normalizePlanningActionLocateFields(actions, {
      actionSpace,
      includeLocateInPlanning: false,
      locateResultContext: { preparedSize: { width: 0, height: 0 } },
      parseRawLocateParameter:
        planningProtocol.actionOutputProtocol.parseRawLocateParameter,
    });
    return normalizePlannedAction(actions[0], context);
  }
  if (parsed.finalizeSuccess === false) {
    return {
      operation: 'BLOCKED',
      ...(parsed.finalizeMessage ? { message: parsed.finalizeMessage } : {}),
      ...context,
    };
  }
  if (parsed.finalizeSuccess === true) {
    return {
      operation: 'DONE',
      ...(parsed.finalizeMessage ? { message: parsed.finalizeMessage } : {}),
      ...context,
    };
  }
  throw plannerError(
    'Tree-only planner returned no action, completion, or error',
  );
}

/**
 * Create an image-free planner bound to a text model runtime. Nested model
 * retries are disabled so recovery stays with the shared tree-only budget.
 */
export function createTreeOnlyPlanner(options: {
  runtime: ModelRuntime;
  actionSpace: readonly DeviceAction<any>[];
  abortSignal?: AbortSignal;
}): TreeOnlyPlanFn {
  const { runtime, actionSpace, abortSignal } = options;
  const planning = runtime.adapter.planning;
  if (planning.kind !== 'standard') {
    throw new TreeOnlyOperationError(
      'Tree-only planning requires a standard planning adapter; custom planning adapters are not supported',
      'unsupported-operation',
    );
  }
  const plannerActionSpace = treeOnlyPlannerActionSpace(actionSpace);
  if (plannerActionSpace.length === 0) {
    throw new TreeOnlyOperationError(
      'Tree-only planning requires Tap, Input, or Scroll in the action space',
      'unsupported-operation',
    );
  }
  const planningProtocol = planning.protocol;
  const systemPrompt = buildTreeOnlyPlanningSystemPrompt({
    actionSpace: plannerActionSpace,
    planningProtocol,
  });
  const modelRuntime: ModelRuntime = {
    ...runtime,
    config: { ...runtime.config, retryCount: 0 },
  };
  return async (input) => {
    const result = await callAI(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: buildTreeOnlyPlannerUserMessage(input),
        },
      ],
      modelRuntime,
      { abortSignal },
    );
    return parseTreeOnlyPlannerDecision(result.content, {
      actionSpace: plannerActionSpace,
      planningProtocol,
    });
  };
}
