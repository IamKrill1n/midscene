import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JevEvaluationError, validateJevAnswers } from '@/tree-only/types';
import type {
  JevAnswer,
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevQuestion,
  JevTransportErrorCategory,
} from '@/tree-only/types';
import { getDebug } from '@midscene/shared/logger';
import { TREE_ONLY_MAX_CHOICE_OPTIONS } from '@midscene/shared/tree-only';
import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
} from '@typesafe-ai/sdk';

/**
 * T03 TypeSafe transport for tree-only Jev evaluation.
 *
 * Owner: T03. Other tasks propose changes to this owner instead of editing
 * these files directly. Scope is limited to
 * `packages/core/src/ai-model/model-adapter/jev-transport.ts` (this file),
 * the additive export in `./index.ts`, and the `@typesafe-ai/sdk` pin in
 * `packages/core/package.json`.
 *
 * Design (verified 2026-09-17 against live TypeSafe docs and SDK v0.6.0):
 * - Typed evaluation only. Requests go through `TypeSafeClient.systemOne`
 *   with text state plus Choice/Noul questions. Nothing here fabricates an
 *   OpenAI chat-completion response and nothing accepts images: the payload
 *   shape is `{ state, model, questions }` with no image fields.
 * - SDK retries are disabled at both levels (client construction and
 *   per-call override) so the shared T04 budget (initial attempt plus two
 *   recoveries) is the only retry mechanism. Enabling SDK retries would
 *   multiply that budget with hidden nested attempts.
 * - Pinned SDK `0.6.0` and reproducible model `jev-1.13.0` (live aliases
 *   `jev-latest`/`jev-preview` resolved to `jev-1.13.0` at verification).
 *   Aliases move, so the response-reported model version is always recorded
 *   and an explicit/`TYPESAFE_MODEL` selection is never silently replaced.
 * - Node-runner only. The API key is read from the environment by the SDK
 *   (`TYPESAFE_API_KEY`) and is never logged, returned, or embedded in
 *   payloads. Do not import this transport into browser bundles.
 */

/** Pinned SDK version installed via pnpm (exact, reproducible). */
export const JEV_SDK_VERSION = '0.6.0';

/**
 * Reproducible model pin for initial acceptance and threshold calibration.
 * Aliases move; the evaluation response reports the actual version, which
 * callers must record instead of assuming the requested name answered.
 */
export const JEV_REPRODUCIBLE_MODEL = 'jev-1.13.0';

/** Aliases known to resolve to the reproducible pin at verification time. */
export const JEV_MODEL_ALIASES = ['jev-latest', 'jev-preview'] as const;

/**
 * Retry override applied to every Jev request. `maxRetries: 0` disables the
 * SDK's default policy (2 retries with backoff); recovery is owned by the
 * shared T04 budget instead. Pass this object (or an equal one) on every
 * `systemOne` call; a mock caller in tests must observe it.
 */
export const JEV_SDK_RETRY_OVERRIDE = { maxRetries: 0 } as const;

/**
 * Opt-in directory for step-level Jev evidence. Unset in normal runs; when
 * set, every evaluation writes request/response/error JSON records (T01/T02)
 * so a failed Interaction Step can be replayed offline. Records contain the
 * text payload only: no images and no credentials.
 */
export const JEV_DUMP_ENV_KEY = 'MIDSCENE_TREE_ONLY_JEVD_DUMP_DIR';

/** Environment keys read for model resolution (values never logged). */
export const JEV_API_ENV_KEYS = {
  apiKey: 'TYPESAFE_API_KEY',
  /** Repository convention for the selected model (see plan T03 note). */
  model: 'TYPESAFE_MODEL',
  /** SDK convention for the default model. */
  defaultModel: 'TYPESAFE_DEFAULT_MODEL',
  baseURL: 'TYPESAFE_BASE_URL',
} as const;

export type JevModelSource =
  | 'explicit'
  | 'TYPESAFE_MODEL'
  | 'TYPESAFE_DEFAULT_MODEL'
  | 'pinned-default';

export interface ResolvedJevModel {
  model: string;
  source: JevModelSource;
}

function readEnvValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve which model name to request without silently overwriting the
 * operator's selection. Precedence: explicit argument, `TYPESAFE_MODEL`,
 * the SDK's `TYPESAFE_DEFAULT_MODEL`, then the reproducible pin. Returns
 * both the name and where it came from so callers can record the choice.
 */
export function resolveJevModel(explicit?: string): ResolvedJevModel {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) {
    return { model: trimmedExplicit, source: 'explicit' };
  }
  const fromTypesafeModel = readEnvValue(JEV_API_ENV_KEYS.model);
  if (fromTypesafeModel) {
    return { model: fromTypesafeModel, source: 'TYPESAFE_MODEL' };
  }
  const fromDefaultModel = readEnvValue(JEV_API_ENV_KEYS.defaultModel);
  if (fromDefaultModel) {
    return { model: fromDefaultModel, source: 'TYPESAFE_DEFAULT_MODEL' };
  }
  return { model: JEV_REPRODUCIBLE_MODEL, source: 'pinned-default' };
}

/**
 * Whether a Jev API key is available to the Node runner. Returns a boolean
 * only: the key value is never returned, printed, or embedded anywhere.
 */
export function hasJevCredentials(): boolean {
  return readEnvValue(JEV_API_ENV_KEYS.apiKey) !== undefined;
}

/** SDK-shaped payload built from T01 typed evaluation requests. */
export interface JevSystemOnePayload {
  state: string;
  model: string;
  questions: Questions;
}

export interface JevCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Injectable SystemOne caller. Real wiring comes from
 * {@link createJevSystemOneCaller}; tests inject mocks. The caller must
 * honor `retry.maxRetries === 0` (no hidden retries); {@link evaluateJev}
 * always passes {@link JEV_SDK_RETRY_OVERRIDE} through.
 */
export type JevSystemOneFn = (
  payload: JevSystemOnePayload,
  options: JevCallOptions & { retry: { maxRetries: number } },
) => Promise<unknown>;

/** Raw evaluation result shape (SDK response or mock equivalent). */
interface JevRawResult {
  model?: unknown;
  answers?: unknown;
  usage?: unknown;
}

function fail(
  message: string,
  category: JevTransportErrorCategory,
  questionId?: string,
): never {
  throw new JevEvaluationError(message, category, questionId);
}

function assertNonEmptyString(
  value: unknown,
  what: string,
  questionId?: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${what} must be a non-empty string`, 'malformed', questionId);
  }
}

/**
 * Build the outgoing SystemOne payload. Rejects empty question sets,
 * duplicate IDs, empty prompts, and Choice questions outside the 1..255
 * option range (one slot is reserved for no-match upstream in T08; this
 * layer never silently truncates). The emitted object contains only
 * `state`, `model`, and `questions`: no images, files, or credentials.
 */
export function buildJevSystemOnePayload(
  request: JevEvaluationRequest,
): JevSystemOnePayload {
  assertNonEmptyString(request.model, 'evaluation model');
  if (typeof request.state !== 'string') {
    fail(
      'evaluation state must be text; images are not supported',
      'malformed',
    );
  }
  if (request.questions.length === 0) {
    fail('at least one question is required', 'malformed');
  }
  const seen = new Set<string>();
  const questions: Questions = {};
  for (const question of request.questions) {
    assertNonEmptyString(question.id, 'question id');
    const questionId: string = question.id;
    if (seen.has(questionId)) {
      fail(`duplicate question id "${questionId}"`, 'malformed', questionId);
    }
    seen.add(questionId);
    if (question.kind === 'choice') {
      assertNonEmptyString(question.prompt, 'choice prompt', question.id);
      if (question.options.length === 0) {
        fail(
          `choice question "${question.id}" needs at least one option`,
          'malformed',
          question.id,
        );
      }
      if (question.options.length > TREE_ONLY_MAX_CHOICE_OPTIONS) {
        fail(
          `choice question "${question.id}" has ${question.options.length} options, exceeding the ${TREE_ONLY_MAX_CHOICE_OPTIONS}-option maximum; narrow candidates with disclosed hierarchical selection instead of truncating`,
          'malformed',
          question.id,
        );
      }
      const criteria: Record<string, string | null> = {};
      for (const option of question.options) {
        assertNonEmptyString(option.id, 'choice option id', question.id);
        criteria[option.id] =
          option.label && option.label !== option.id ? option.label : null;
      }
      questions[question.id] = {
        type: 'choice',
        instructions: question.prompt,
        criteria,
      };
    } else if (question.kind === 'noul') {
      assertNonEmptyString(question.statement, 'noul statement', question.id);
      questions[question.id] = {
        type: 'noul',
        instructions: question.statement,
      };
    } else {
      // Unreachable for typed callers (JevQuestion is choice | noul); the
      // runtime guard keeps malformed payloads from reaching the provider.
      const unknownKind = (question as { kind?: unknown }).kind;
      fail(
        `unsupported question kind "${String(unknownKind)}" for "${questionId}"`,
        'malformed',
        questionId,
      );
    }
  }
  return { state: request.state, model: request.model, questions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertProbability(
  value: unknown,
  what: string,
  questionId: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    fail(`${what} must be a number between 0 and 1`, 'malformed', questionId);
  }
}

/**
 * Convert a raw SystemOne result into T01 typed answers. Validates that
 * every asked question has exactly one answer of the matching kind, that
 * Choice selections reference supplied options, and that probabilities are
 * finite numbers in range. Score answers are rejected as malformed: the
 * tree-only scope supports Choice and Noul only. Usage tokens and the
 * provider-reported model version are carried over without fabrication.
 */
export function parseJevSystemOneResult(
  questions: readonly JevQuestion[],
  raw: unknown,
): JevEvaluationResponse {
  if (!isRecord(raw)) {
    fail('evaluation response must be an object', 'malformed');
  }
  const { model, answers, usage } = raw as JevRawResult;
  assertNonEmptyString(model, 'response model');
  if (!isRecord(answers)) {
    fail('evaluation response answers must be an object', 'malformed');
  }
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const questionId of Object.keys(answers)) {
    if (!byId.has(questionId)) {
      fail(
        `answer references unknown question "${questionId}"`,
        'missing',
        questionId,
      );
    }
  }
  const parsed: JevAnswer[] = [];
  for (const question of questions) {
    const answer = (answers as Record<string, unknown>)[question.id];
    if (answer === undefined) {
      fail(
        `missing answer for question "${question.id}"`,
        'missing',
        question.id,
      );
    }
    if (!isRecord(answer)) {
      fail(
        `answer for "${question.id}" must be an object`,
        'malformed',
        question.id,
      );
    }
    if (answer.type !== question.kind) {
      fail(
        `answer type "${String(answer.type)}" does not match question kind ` +
          `"${question.kind}" for "${question.id}"`,
        'malformed',
        question.id,
      );
    }
    if (question.kind === 'choice') {
      const optionId = answer.choice;
      const known = new Set(question.options.map((option) => option.id));
      if (typeof optionId !== 'string' || !known.has(optionId)) {
        fail(
          `answer selects unknown option "${String(optionId)}" for "${question.id}"`,
          'malformed',
          question.id,
        );
      }
      const distribution =
        answer.probabilities === undefined
          ? undefined
          : toDistribution(answer.probabilities, question.id);
      const confidence =
        answer.confidence === undefined
          ? undefined
          : toConfidence(answer.confidence, question.id);
      parsed.push({
        questionId: question.id,
        kind: 'choice',
        optionId,
        ...(distribution === undefined ? {} : { distribution }),
        ...(confidence === undefined ? {} : { confidence }),
      });
    } else {
      assertProbability(
        answer.noul,
        `noul value for "${question.id}"`,
        question.id,
      );
      parsed.push({
        questionId: question.id,
        kind: 'noul',
        probabilityYes: answer.noul,
      });
    }
  }
  // Reuse the shared T01 contract as the final gate (unknown IDs, kind
  // mismatches, invented options, out-of-range probabilities).
  validateJevAnswers(questions, parsed);
  return {
    answers: parsed,
    ...(usage === undefined ? {} : { usage: toUsage(usage) }),
    model,
  };
}

function toDistribution(
  value: unknown,
  questionId: string,
): Record<string, number> {
  if (!isRecord(value)) {
    fail(
      `choice probabilities for "${questionId}" must be an object`,
      'malformed',
      questionId,
    );
  }
  const distribution: Record<string, number> = {};
  for (const [optionId, probability] of Object.entries(value)) {
    assertProbability(
      probability,
      `probability for option "${optionId}" in "${questionId}"`,
      questionId,
    );
    distribution[optionId] = probability;
  }
  return distribution;
}

function toConfidence(value: unknown, questionId: string): number {
  assertProbability(value, `confidence for "${questionId}"`, questionId);
  return value;
}

function toUsage(value: unknown): JevEvaluationResponse['usage'] {
  if (!isRecord(value)) {
    fail('evaluation usage must be an object', 'malformed');
  }
  const input = (value as Record<string, unknown>).input_tokens;
  const output = (value as Record<string, unknown>).output_tokens;
  // Accept the SDK's snake_case names; tolerate providers that already use
  // camelCase without inventing counts for absent fields.
  const promptTokens =
    input ??
    (value as Record<string, unknown>).promptTokens ??
    (value as Record<string, unknown>).prompt_tokens;
  const completionTokens =
    output ??
    (value as Record<string, unknown>).completionTokens ??
    (value as Record<string, unknown>).completion_tokens;
  const usage: NonNullable<JevEvaluationResponse['usage']> = {};
  if (promptTokens !== undefined) {
    assertTokenCount(promptTokens, 'promptTokens');
    usage.promptTokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    assertTokenCount(completionTokens, 'completionTokens');
    usage.completionTokens = completionTokens;
  }
  if (
    usage.promptTokens !== undefined &&
    usage.completionTokens !== undefined
  ) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return usage;
}

function assertTokenCount(
  value: unknown,
  what: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    fail(
      `evaluation usage ${what} must be a non-negative integer`,
      'malformed',
    );
  }
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * Whether an error (raw or wrapped with `cause`) represents caller
 * cancellation. Abort errors propagate unwrapped from {@link evaluateJev};
 * wrapped service-failure errors keep the original as `cause` so T04 can
 * still distinguish cancellation from retryable failures.
 */
export function isJevAbortError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof Error &&
      (current.name === 'APIUserAbortError' ||
        /abort/i.test(current.message) ||
        /aborted/i.test(current.message))
    ) {
      // Only treat generic abort messages as cancellation when they come
      // from the SDK abort class or carry an AbortSignal reason chain.
      if (
        current.name === 'APIUserAbortError' ||
        current.name === 'AbortError' ||
        /APIUserAbortError/.test(String((current as { cause?: unknown }).cause))
      ) {
        return true;
      }
      if (current.name === 'JevEvaluationError') {
        const cause = (current as { cause?: unknown }).cause;
        if (cause !== undefined) {
          current = cause;
          continue;
        }
      }
      return false;
    }
    const cause = (current as { cause?: unknown }).cause;
    if (
      cause === undefined ||
      (typeof cause !== 'object' && typeof cause !== 'string')
    ) {
      return false;
    }
    if (typeof cause === 'string') {
      return /abort/i.test(cause);
    }
    current = cause;
  }
  return false;
}

function withCause(
  error: JevEvaluationError,
  cause: unknown,
): JevEvaluationError {
  (error as { cause?: unknown }).cause = cause;
  return error;
}

/**
 * Map SDK/transport failures onto the three T01 transport categories:
 * - `missing`: no API key, authentication/permission failures (401/403),
 *   unknown question IDs, or absent answers. Permanent: do not retry.
 * - `malformed`: request validation failures (400/422), bad response
 *   shapes, kind mismatches, invented options, out-of-range values.
 *   Permanent: do not retry.
 * - `service-failure`: rate limits (429), overload (529/5xx), timeouts,
 *   and connection errors. Transient: may recover within the shared T04
 *   budget.
 * Caller aborts (`APIUserAbortError`) propagate unwrapped so cancellation
 * is never mistaken for a retryable failure.
 */
export function toJevTransportError(error: unknown): JevEvaluationError {
  if (error instanceof JevEvaluationError) {
    return error;
  }
  if (errorName(error) === 'APIUserAbortError') {
    throw error;
  }
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  if (
    errorName(error) === 'TypeSafeError' &&
    /api key/i.test(message) &&
    status === undefined
  ) {
    return withCause(
      new JevEvaluationError(
        'missing TypeSafe API key: set TYPESAFE_API_KEY in the Node runner environment',
        'missing',
      ),
      error,
    );
  }
  if (status === 401 || status === 403) {
    return withCause(
      new JevEvaluationError(
        `TypeSafe authentication failed (status ${status}); check the runner API key without printing it`,
        'missing',
      ),
      error,
    );
  }
  if (status === 400 || status === 422) {
    return withCause(
      new JevEvaluationError(
        `TypeSafe request validation failed (status ${status}): ${message}`,
        'malformed',
      ),
      error,
    );
  }
  if (
    errorName(error) === 'TypeSafeError' ||
    /at least one question is required/i.test(message)
  ) {
    return withCause(
      new JevEvaluationError(`invalid Jev request: ${message}`, 'malformed'),
      error,
    );
  }
  return withCause(
    new JevEvaluationError(
      `TypeSafe service failure: ${message}`,
      'service-failure',
    ),
    error,
  );
}

const debugJev = getDebug('jev-transport');

export type JevDumpKind = 'request' | 'response' | 'error';

let jevDumpSequence = 0;

function readJevDumpDir(): string | undefined {
  return readEnvValue(JEV_DUMP_ENV_KEY);
}

/**
 * Persist one evidence record for offline replay. Capture is diagnostic: a
 * filesystem failure is logged and swallowed because it must never change
 * evaluation behavior.
 */
async function writeJevDump(
  dir: string,
  record: { kind: JevDumpKind } & Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    jevDumpSequence += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // The module can be loaded through more than one build (ESM and CJS),
    // so the in-module counter alone is not globally unique: add the pid and
    // a random suffix to keep every record a distinct file.
    const unique = `${process.pid}-${jevDumpSequence}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const name = `${stamp}-${unique}-${record.kind}.json`;
    await writeFile(join(dir, name), JSON.stringify(record, null, 2), 'utf8');
  } catch (error) {
    debugJev(
      `failed to write dump record to "${dir}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { console: true },
    );
  }
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof JevEvaluationError) {
    return {
      name: error.name,
      message: error.message,
      category: error.category,
      ...(error.questionId !== undefined
        ? { questionId: error.questionId }
        : {}),
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

/**
 * Run one typed evaluation through the injected caller. Builds the
 * image-free SystemOne payload, forwards the retry-disabled override, and
 * parses/validates the typed result. Throws {@link JevEvaluationError} with
 * a `missing`, `malformed`, or `service-failure` category; aborts
 * propagate unwrapped.
 */
export async function evaluateJev(
  request: JevEvaluationRequest,
  caller: JevSystemOneFn,
  options?: JevCallOptions,
): Promise<JevEvaluationResponse> {
  const dumpDir = readJevDumpDir();
  const startedAt = Date.now();
  const payload = buildJevSystemOnePayload(request);
  if (dumpDir) {
    await writeJevDump(dumpDir, {
      kind: 'request',
      recordedAt: new Date().toISOString(),
      sdkVersion: JEV_SDK_VERSION,
      request: payload,
    });
  }
  let raw: unknown;
  try {
    raw = await caller(payload, {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      retry: { ...JEV_SDK_RETRY_OVERRIDE },
    });
  } catch (error) {
    const transportError = toJevTransportError(error);
    if (dumpDir) {
      await writeJevDump(dumpDir, {
        kind: 'error',
        phase: 'call',
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: describeError(transportError),
      });
    }
    throw transportError;
  }
  try {
    const parsed = parseJevSystemOneResult(request.questions, raw);
    if (dumpDir) {
      await writeJevDump(dumpDir, {
        kind: 'response',
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        raw,
        parsed,
      });
    }
    return parsed;
  } catch (error) {
    const transportError =
      error instanceof JevEvaluationError ? error : toJevTransportError(error);
    if (dumpDir) {
      await writeJevDump(dumpDir, {
        kind: 'error',
        phase: 'parse',
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: describeError(transportError),
      });
    }
    throw transportError;
  }
}

/**
 * Create the real SystemOne caller from the documented JavaScript SDK.
 * The client is constructed with retries disabled (`maxRetries: 0`) and
 * every call repeats that override, so SDK backoff can never multiply the
 * shared T04 recovery budget. When `apiKey` is omitted the SDK reads
 * `TYPESAFE_API_KEY` itself; this function never prints the value.
 * Node-runner only: rejects browser use like the SDK does.
 */
export async function createJevSystemOneCaller(clientOptions?: {
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
}): Promise<JevSystemOneFn> {
  const { TypeSafeClient } = await import('@typesafe-ai/sdk');
  const client = new TypeSafeClient({
    ...(clientOptions?.apiKey !== undefined
      ? { apiKey: clientOptions.apiKey }
      : {}),
    ...(clientOptions?.baseURL !== undefined
      ? { baseURL: clientOptions.baseURL }
      : {}),
    retry: { ...JEV_SDK_RETRY_OVERRIDE },
    ...(clientOptions?.timeoutMs !== undefined
      ? { timeout: clientOptions.timeoutMs }
      : {}),
  });
  return (
    payload: JevSystemOnePayload,
    options: JevCallOptions & { retry: { maxRetries: number } },
  ) =>
    client.systemOne(payload as unknown as SystemOneRequest<Questions>, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeout: options.timeoutMs }
        : {}),
      retry: { ...JEV_SDK_RETRY_OVERRIDE, ...options.retry },
    }) as unknown as Promise<unknown>;
}

/** Type-level assertion that parsed results keep the SDK result shape. */
export type JevSystemOneResultShape = Pick<
  SystemOneResult<Questions>,
  'model' | 'answers' | 'usage'
>;
