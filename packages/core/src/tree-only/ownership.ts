/**
 * T01 file-ownership map for parallel tree-only implementation.
 *
 * After T01, one owner edits each shared interface/config/export file;
 * other tasks propose changes to that owner instead of rewriting the
 * same file. Integration tasks (T07/T11) consume these interfaces after
 * their prerequisites land. Paths are relative to `vendor/midscene/`.
 */

export interface TreeOnlyFileOwnership {
  /** Task that owns edits to these files. */
  owner: string;
  /** Concrete files (or globs) owned by the task. */
  files: string[];
  /** What the owner exposes for downstream tasks to consume. */
  exposes: string[];
}

export const TREE_ONLY_SHARED_INTERFACES = [
  'packages/shared/src/tree-only/types.ts',
  'packages/shared/src/tree-only/index.ts',
  'packages/core/src/tree-only/types.ts',
  'packages/core/src/tree-only/ownership.ts',
  'packages/core/src/tree-only/index.ts',
] as const;

export const TREE_ONLY_FILE_OWNERSHIP: Record<string, TreeOnlyFileOwnership> = {
  configuration: {
    owner: 'T02',
    files: [
      'packages/core/src/types.ts (AgentOpt.inputMode only)',
      'packages/core/src/yaml.ts (inputMode forwarding only)',
      'packages/core/src/agent/test-runner-nodes.ts (schema only)',
    ],
    exposes: ['effective mode resolution honoring T01 mode types'],
  },
  transport: {
    owner: 'T03',
    files: [
      'packages/core/src/ai-model/model-adapter/** (Jev adapter only)',
      'packages/core/package.json (SDK pin only)',
      'packages/core/pnpm-lock.yaml (via pnpm only)',
    ],
    exposes: ['typed Jev evaluation honoring T01 question/answer types'],
  },
  lifecycle: {
    owner: 'T04',
    files: [
      'packages/core/src/agent/execution-session.ts (recovery wiring only)',
      'packages/core/src/task-runner.ts (deadline/cancel only)',
    ],
    exposes: ['shared recovery budget honoring T01 budget helpers'],
  },
  capture: {
    owner: 'T05',
    files: [
      'packages/shared/src/extractor/** (collector only)',
      'packages/web-integration/src/**/snapshot*.ts (new files only)',
    ],
    exposes: ['browser snapshots honoring T01 snapshot types'],
  },
  fixtures: {
    owner: 'T06',
    files: ['packages/*/tests/** (new tree-only fixtures only)'],
    exposes: ['fixed fixture revisions and labeled yes/no/uncertain sets'],
  },
  requestBoundary: {
    owner: 'T07',
    files: [
      'packages/core/src/ai-model/service-caller/** (tree-only guard only)',
    ],
    exposes: ['image-free request validation'],
  },
  selection: {
    owner: 'T08',
    files: ['packages/core/src/tree-only/selection.ts (new file, T08 creates)'],
    exposes: ['Choice candidate selection with reserved no-match'],
  },
  validation: {
    owner: 'T09',
    files: [
      'packages/web-integration/src/**/input-validation*.ts (new files only)',
    ],
    exposes: ['freshness/geometry/ownership checks before input'],
  },
  reporting: {
    owner: 'T10',
    files: [
      'packages/core/src/dump/report-action-dump.ts (event fields only)',
      'packages/core/src/report.ts (usage plumbing only)',
    ],
    exposes: ['native event serialization honoring T01 event fields'],
  },
  android: {
    owner: 'T15/T18',
    files: [
      'packages/android/src/ui-tree.ts',
      'packages/android/src/ui-tree-capture.ts',
      'packages/android/src/device.ts (tree-only path only)',
    ],
    exposes: ['Android snapshots reusing the shared outer record'],
  },
};
