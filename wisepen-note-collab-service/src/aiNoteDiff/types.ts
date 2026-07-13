export type JsonRecord = Record<string, unknown>;

export type NoteInlineContent = {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: NoteInlineContent[];
  props?: JsonRecord;
};

export type NoteBlock = {
  id: string;
  type: string;
  props: JsonRecord;
  content?: unknown;
  // Sparse AI review layer: missing means the AI version is identical to content.
  'AI-content'?: unknown;
  children: NoteBlock[];
};

export type NoteXmlScope =
  | { type: 'whole_note' }
  | { type: 'blocks'; block_ids: string[]; include_children?: boolean }
  | { type: 'subtree'; root_block_id: string }
  | {
      type: 'block_range';
      start_block_id: string;
      end_block_id: string;
      include_partial?: boolean;
    };

export type NormalizedNoteXmlScope =
  | { type: 'whole_note' }
  | { type: 'blocks'; block_ids: string[]; include_children: boolean }
  | { type: 'subtree'; root_block_id: string }
  | {
      type: 'block_range';
      start_block_id: string;
      end_block_id: string;
      include_partial: false;
    };

export type SkippedTargetSummary = {
  xmlId?: string;
  kind: string;
  reason: string;
};

export type TargetKind =
  | 'block'
  | 'text'
  | 'link'
  | 'inlineMath'
  | 'mathExpression';

export type BaseTargetInfo = {
  xmlId: string;
  kind: TargetKind;
  blockId: string;
  blockType: string;
  blockHash: string;
};

export type BlockTargetInfo = BaseTargetInfo & {
  kind: 'block';
};

export type TextTargetInfo = BaseTargetInfo & {
  kind: 'text';
  contentIndex: number;
  text: string;
  textHash: string;
};

export type LinkTargetInfo = BaseTargetInfo & {
  kind: 'link';
  contentIndex: number;
  text: string;
  href: string;
  textHash: string;
  hrefHash: string;
};

export type InlineMathTargetInfo = BaseTargetInfo & {
  kind: 'inlineMath';
  contentIndex: number;
  expression: string;
  expressionHash: string;
};

export type MathExpressionTargetInfo = BaseTargetInfo & {
  kind: 'mathExpression';
  expression: string;
  expressionHash: string;
};

export type TargetInfo =
  | BlockTargetInfo
  | TextTargetInfo
  | LinkTargetInfo
  | InlineMathTargetInfo
  | MathExpressionTargetInfo;

export type TargetIndex = {
  targets: Record<string, TargetInfo>;
};

export type NoteXmlBundle = {
  exportHandle: string;
  resourceId: string;
  actorUserId: string;
  scope: NormalizedNoteXmlScope;
  version: number;
  aiXml: string;
  targetIndex: TargetIndex;
  idMapping: Record<string, string>;
  normalizedBlocks: NoteBlock[];
  skippedTargets: SkippedTargetSummary[];
  createdAt: number;
  expiresAt: number;
};

export type ReadNoteRequest = {
  resourceId: string;
  scope?: NoteXmlScope;
  requireLiveRoom?: boolean;
  clientContentSignature?: string;
  clientStateVector?: string;
};

export type ReadNoteResponse = {
  resourceId: string;
  exportHandle: string;
  scope: NormalizedNoteXmlScope;
  version: number;
  aiXml: string;
  skippedTargets: SkippedTargetSummary[];
  expiresAt: string;
};

export type AiXmlModificationPlan = {
  version: 1;
  operations: unknown[];
};

export type ApplyPlanRequest = {
  resourceId: string;
  exportHandle: string;
  plan: AiXmlModificationPlan;
  requireLiveRoom?: boolean;
  clientContentSignature?: string;
  clientStateVector?: string;
  selectedText?: string;
  selectedTextBoundary?: boolean;
};

export type OperationPosition = 'before' | 'after';

export type PatchOperation =
  | { opId: string; kind: 'replace_text'; target: string; text: string }
  | { opId: string; kind: 'replace_link'; target: string; text: string; href: string }
  | { opId: string; kind: 'replace_inline_math'; target: string; expression: string }
  | { opId: string; kind: 'replace_math_expression'; target: string; expression: string }
  | { opId: string; kind: 'add_text'; anchor: string; position: OperationPosition; text: string }
  | {
      opId: string;
      kind: 'add_link';
      anchor: string;
      position: OperationPosition;
      text: string;
      href: string;
    }
  | {
      opId: string;
      kind: 'add_inline_math';
      anchor: string;
      position: OperationPosition;
      expression: string;
    }
  | {
      opId: string;
      kind: 'add_block';
      anchor: string;
      position: OperationPosition;
      blockType: string;
      text?: string;
      expression?: string;
    }
  | { opId: string; kind: 'delete_target'; target: string }
  | { opId: string; kind: 'delete_block'; target: string };

export type ApplyOperation = PatchOperation & {
  targetInfo?: TargetInfo;
  anchorInfo?: TargetInfo;
};

export type ApplyResultReason =
  | 'block_missing'
  | 'block_type_changed'
  | 'target_path_unlocatable'
  | 'target_kind_changed'
  | 'target_value_changed'
  | 'add_anchor_missing'
  | 'add_anchor_kind_changed'
  | 'delete_target_missing'
  | 'pending_ai_diff_exists'
  | 'unsupported_target';

export type ApplyFailureResult = {
  opId: string;
  reason: ApplyResultReason;
};

export type ApplyPlanResult = {
  summary: {
    applied: number;
    staleApplied: number;
    conflicts: number;
    skipped: number;
  };
  applied: string[];
  staleApplied: string[];
  conflicts: ApplyFailureResult[];
  skipped: ApplyFailureResult[];
};

export type ApplyPlanResponse = ApplyPlanResult & {
  resourceId: string;
  exportHandle: string;
};

export type ClassifiedApplyOperation = ApplyOperation & {
  status: 'applied' | 'staleApplied' | 'conflict' | 'skipped';
  reason?: ApplyResultReason;
};
