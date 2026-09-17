import {
  JEV_MODEL_ALIASES,
  JEV_REPRODUCIBLE_MODEL,
  JEV_SDK_RETRY_OVERRIDE,
  JEV_SDK_VERSION,
  buildJevSystemOnePayload,
  evaluateJev,
  hasJevCredentials,
  isJevAbortError,
  parseJevSystemOneResult,
  resolveJevModel,
  toJevTransportError,
} from '@/ai-model/model-adapter/jev-transport';
import type {
  JevSystemOneFn,
  JevSystemOnePayload,
} from '@/ai-model/model-adapter/jev-transport';
import { JevEvaluationError } from '@/tree-only/types';
import type { JevEvaluationRequest, JevQuestion } from '@/tree-only/types';
import { describe, expect, it } from '@rstest/core';

const choiceQuestion: JevQuestion = {
  id: 'q-target',
  kind: 'choice',
  prompt: 'Which candidate matches "Submit"?',
  options: [
    { id: 'submit', label: 'Submit button' },
    { id: 'no-match', label: 'No matching candidate' },
  ],
};

const noulQuestion: JevQuestion = {
  id: 'q-submitted',
  kind: 'noul',
  statement: 'The form is submitted.',
};

function mockCaller(
  raw: unknown,
  onCall?: (
    payload: JevSystemOnePayload,
    options: Parameters<JevSystemOneFn>[1],
  ) => void,
): JevSystemOneFn {
  return async (payload, options) => {
    onCall?.(payload, options);
    return raw;
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe('jev transport payload', () => {
  it('pins the documented SDK and reproducible model', () => {
    expect(JEV_SDK_VERSION).toBe('0.6.0');
    expect(JEV_REPRODUCIBLE_MODEL).toBe('jev-1.13.0');
    expect([...JEV_MODEL_ALIASES]).toEqual(['jev-latest', 'jev-preview']);
  });

  it('builds an image-free SystemOne payload from typed questions', () => {
    const payload = buildJevSystemOnePayload({
      state: 'tree text',
      model: 'jev-1.13.0',
      questions: [choiceQuestion, noulQuestion],
    });
    expect(Object.keys(payload).sort()).toEqual([
      'model',
      'questions',
      'state',
    ]);
    expect(payload.state).toBe('tree text');
    expect(payload.model).toBe('jev-1.13.0');
    expect(payload.questions['q-target']).toEqual({
      type: 'choice',
      instructions: 'Which candidate matches "Submit"?',
      criteria: {
        submit: 'Submit button',
        'no-match': 'No matching candidate',
      },
    });
    expect(payload.questions['q-submitted']).toEqual({
      type: 'noul',
      instructions: 'The form is submitted.',
    });
    const serialized = JSON.stringify(payload);
    for (const imageKey of [
      'image_url',
      'imageUrl',
      'screenshot',
      'base64',
      'apiKey',
      'api_key',
      'Authorization',
    ]) {
      expect(serialized).not.toContain(imageKey);
    }
  });

  it('leaves option descriptions undescribed when the label equals the id', () => {
    const payload = buildJevSystemOnePayload({
      state: 's',
      model: 'jev-1.13.0',
      questions: [
        {
          id: 'q',
          kind: 'choice',
          prompt: 'Pick one.',
          options: [{ id: 'a', label: 'a' }],
        },
      ],
    });
    expect(payload.questions.q).toEqual({
      type: 'choice',
      instructions: 'Pick one.',
      criteria: { a: null },
    });
  });

  it('rejects empty, duplicated, and oversized question sets as malformed', () => {
    expect(() =>
      buildJevSystemOnePayload({
        state: 's',
        model: 'jev-1.13.0',
        questions: [],
      }),
    ).toThrow(JevEvaluationError);
    try {
      buildJevSystemOnePayload({
        state: 's',
        model: 'jev-1.13.0',
        questions: [],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as JevEvaluationError).category).toBe('malformed');
    }

    expect(() =>
      buildJevSystemOnePayload({
        state: 's',
        model: 'jev-1.13.0',
        questions: [choiceQuestion, { ...choiceQuestion }],
      }),
    ).toThrow(/duplicate question id/);

    const overflow = Array.from({ length: 256 }, (_, index) => ({
      id: `opt-${index}`,
      label: `Option ${index}`,
    }));
    try {
      buildJevSystemOnePayload({
        state: 's',
        model: 'jev-1.13.0',
        questions: [
          {
            id: 'q-big',
            kind: 'choice',
            prompt: 'Pick one.',
            options: overflow,
          },
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as JevEvaluationError).category).toBe('malformed');
      expect(String((error as Error).message)).toMatch(
        /never silently truncate|exceeding/i,
      );
    }
  });
});

describe('jev transport response parsing', () => {
  const questions: JevQuestion[] = [choiceQuestion, noulQuestion];

  it('maps typed answers, actual usage, and the resolved model version', () => {
    const response = parseJevSystemOneResult(questions, {
      model: 'jev-1.13.0',
      answers: {
        'q-target': {
          type: 'choice',
          choice: 'submit',
          probabilities: { submit: 0.8, 'no-match': 0.2 },
          confidence: 0.75,
        },
        'q-submitted': { type: 'noul', noul: 0.92 },
      },
      usage: { input_tokens: 312, output_tokens: 48 },
    });
    expect(response.model).toBe('jev-1.13.0');
    expect(response.answers).toEqual([
      {
        questionId: 'q-target',
        kind: 'choice',
        optionId: 'submit',
        distribution: { submit: 0.8, 'no-match': 0.2 },
        confidence: 0.75,
      },
      { questionId: 'q-submitted', kind: 'noul', probabilityYes: 0.92 },
    ]);
    expect(response.usage).toEqual({
      promptTokens: 312,
      completionTokens: 48,
      totalTokens: 360,
    });
  });

  it('reports the alias-resolved version instead of the requested alias', () => {
    const response = parseJevSystemOneResult([choiceQuestion], {
      model: 'jev-1.13.0',
      answers: {
        'q-target': { type: 'choice', choice: 'no-match' },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(response.model).toBe('jev-1.13.0');
  });

  it('classifies unknown question IDs and absent answers as missing', () => {
    try {
      parseJevSystemOneResult(questions, {
        model: 'jev-1.13.0',
        answers: {
          'q-target': { type: 'choice', choice: 'submit' },
          'q-unknown': { type: 'noul', noul: 0.5 },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as JevEvaluationError).category).toBe('missing');
      expect((error as JevEvaluationError).questionId).toBe('q-unknown');
    }

    try {
      parseJevSystemOneResult(questions, {
        model: 'jev-1.13.0',
        answers: {
          'q-target': { type: 'choice', choice: 'submit' },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as JevEvaluationError).category).toBe('missing');
      expect((error as JevEvaluationError).questionId).toBe('q-submitted');
    }
  });

  it('classifies kind mismatches, invented options, and bad values as malformed', () => {
    const cases: Array<{ name: string; answers: unknown }> = [
      {
        name: 'kind mismatch',
        answers: {
          'q-target': { type: 'noul', noul: 0.9 },
          'q-submitted': { type: 'noul', noul: 0.1 },
        },
      },
      {
        name: 'invented option',
        answers: {
          'q-target': { type: 'choice', choice: 'invented' },
          'q-submitted': { type: 'noul', noul: 0.1 },
        },
      },
      {
        name: 'out-of-range noul',
        answers: {
          'q-target': { type: 'choice', choice: 'submit' },
          'q-submitted': { type: 'noul', noul: 1.5 },
        },
      },
      {
        name: 'score answer unsupported',
        answers: {
          'q-target': {
            type: 'score',
            score: 1,
            confidence: 0.5,
            legend: { 0: 'low', 1: 'high' },
            probabilities: { 0: 0.5, 1: 0.5 },
          },
          'q-submitted': { type: 'noul', noul: 0.1 },
        },
      },
    ];
    for (const { name, answers } of cases) {
      try {
        parseJevSystemOneResult(questions, { model: 'jev-1.13.0', answers });
        expect.unreachable(name);
      } catch (error) {
        expect((error as JevEvaluationError).category).toBe('malformed');
      }
    }
  });
});

describe('jev transport error mapping', () => {
  it('maps 401/403 to missing, 422 to malformed, and 429/5xx/timeouts to service-failure', () => {
    const auth = Object.assign(new Error('401 Unauthorized'), {
      name: 'AuthenticationError',
      status: 401,
    });
    expect(toJevTransportError(auth).category).toBe('missing');

    const forbidden = Object.assign(new Error('403 Forbidden'), {
      name: 'PermissionDeniedError',
      status: 403,
    });
    expect(toJevTransportError(forbidden).category).toBe('missing');

    const invalid = Object.assign(new Error('422 detail'), {
      name: 'UnprocessableEntityError',
      status: 422,
    });
    expect(toJevTransportError(invalid).category).toBe('malformed');

    const rateLimited = Object.assign(new Error('429 Too Many Requests'), {
      name: 'RateLimitError',
      status: 429,
    });
    expect(toJevTransportError(rateLimited).category).toBe('service-failure');

    const overloaded = Object.assign(new Error('529 Overloaded'), {
      status: 529,
    });
    expect(toJevTransportError(overloaded).category).toBe('service-failure');

    const timeout = Object.assign(new Error('Request timed out after 1ms.'), {
      name: 'APITimeoutError',
    });
    expect(toJevTransportError(timeout).category).toBe('service-failure');

    const connection = Object.assign(new Error('Connection error: reset'), {
      name: 'APIConnectionError',
    });
    expect(toJevTransportError(connection).category).toBe('service-failure');
  });

  it('maps a missing API key to missing without exposing the value', () => {
    const noKey = Object.assign(
      new Error(
        'No API key was provided. Pass `apiKey` to the TypeSafeClient constructor or set the TYPESAFE_API_KEY environment variable.',
      ),
      { name: 'TypeSafeError' },
    );
    const mapped = toJevTransportError(noKey);
    expect(mapped.category).toBe('missing');
    expect(mapped.message).toContain('TYPESAFE_API_KEY');
    expect(mapped.message).not.toMatch(/[A-Za-z0-9]{16,}/);
  });

  it('lets caller aborts propagate unwrapped for T04 cancellation handling', async () => {
    const abortError = Object.assign(new Error('Request was aborted.'), {
      name: 'APIUserAbortError',
    });
    const request: JevEvaluationRequest = {
      state: 's',
      model: 'jev-1.13.0',
      questions: [choiceQuestion],
    };
    const failing: JevSystemOneFn = async () => {
      throw abortError;
    };
    await expect(evaluateJev(request, failing)).rejects.toBe(abortError);
    expect(isJevAbortError(abortError)).toBe(true);
    expect(isJevAbortError(toJevTransportError(new Error('boom')))).toBe(false);
  });
});

describe('jev transport evaluation', () => {
  const request: JevEvaluationRequest = {
    state: 'tree text',
    model: 'jev-1.13.0',
    questions: [choiceQuestion, noulQuestion],
  };

  it('disables SDK retries on every call so the shared budget owns recovery', async () => {
    const seen: Array<Parameters<JevSystemOneFn>[1]> = [];
    const caller = mockCaller(
      {
        model: 'jev-1.13.0',
        answers: {
          'q-target': { type: 'choice', choice: 'submit' },
          'q-submitted': { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 5, output_tokens: 1 },
      },
      (_payload, options) => {
        seen.push(options);
      },
    );
    await evaluateJev(request, caller, { timeoutMs: 1000 });
    expect(seen).toHaveLength(1);
    expect(seen[0].retry.maxRetries).toBe(0);
    expect(JEV_SDK_RETRY_OVERRIDE.maxRetries).toBe(0);
  });

  it('sends only the typed payload through the injected caller (no chat shim)', async () => {
    let observed: JevSystemOnePayload | undefined;
    const caller = mockCaller(
      {
        model: 'jev-1.13.0',
        answers: {
          'q-target': { type: 'choice', choice: 'no-match' },
          'q-submitted': { type: 'noul', noul: 0.5 },
        },
      },
      (payload) => {
        observed = payload;
      },
    );
    const response = await evaluateJev(request, caller);
    expect(Object.keys(observed ?? {}).sort()).toEqual([
      'model',
      'questions',
      'state',
    ]);
    expect(response.answers).toHaveLength(2);
  });
});

describe('jev model and credential resolution', () => {
  it('never overwrites an explicit model selection', () => {
    withEnv(
      {
        TYPESAFE_MODEL: 'jev-1.13.0',
        TYPESAFE_DEFAULT_MODEL: 'jev-latest',
      },
      () => {
        expect(resolveJevModel('jev-preview')).toEqual({
          model: 'jev-preview',
          source: 'explicit',
        });
      },
    );
  });

  it('prefers TYPESAFE_MODEL, then the SDK default, then the pin', () => {
    withEnv(
      {
        TYPESAFE_MODEL: 'jev-1.13.0',
        TYPESAFE_DEFAULT_MODEL: 'jev-latest',
      },
      () => {
        expect(resolveJevModel()).toEqual({
          model: 'jev-1.13.0',
          source: 'TYPESAFE_MODEL',
        });
      },
    );
    withEnv(
      { TYPESAFE_MODEL: undefined, TYPESAFE_DEFAULT_MODEL: 'jev-latest' },
      () => {
        expect(resolveJevModel()).toEqual({
          model: 'jev-latest',
          source: 'TYPESAFE_DEFAULT_MODEL',
        });
      },
    );
    withEnv(
      { TYPESAFE_MODEL: undefined, TYPESAFE_DEFAULT_MODEL: undefined },
      () => {
        expect(resolveJevModel()).toEqual({
          model: 'jev-1.13.0',
          source: 'pinned-default',
        });
      },
    );
  });

  it('checks runner credential loading without exposing values', () => {
    withEnv({ TYPESAFE_API_KEY: 'test-key-value' }, () => {
      expect(hasJevCredentials()).toBe(true);
    });
    withEnv({ TYPESAFE_API_KEY: undefined }, () => {
      expect(hasJevCredentials()).toBe(false);
    });
    withEnv({ TYPESAFE_API_KEY: '   ' }, () => {
      expect(hasJevCredentials()).toBe(false);
    });
  });
});
