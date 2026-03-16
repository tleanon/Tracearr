import type {
  RuleConditions,
  ConditionGroup,
  Condition,
  ConditionField,
  RuleV2,
  ConditionEvidence,
  GroupEvidence,
} from '@tracearr/shared';
import type {
  EvaluationContext,
  EvaluationResult,
  ConditionEvaluator,
  EvaluatorResult,
} from './types.js';
import { evaluatorRegistry } from './evaluators/index.js';
import { rulesLogger as logger } from '../../utils/logger.js';

/**
 * Condition fields whose evaluated value changes when transcode state changes mid-session.
 * Rules containing at least one of these fields are re-evaluated on transcode state transitions
 * (e.g., direct play -> transcode). Rules with only non-transcode fields (like concurrent_streams)
 * are skipped to avoid false positives since those conditions don't change mid-session.
 */
const TRANSCODE_CONDITION_FIELDS: ReadonlySet<ConditionField> = new Set([
  'is_transcoding',
  'is_transcode_downgrade',
  'output_resolution',
]);

/**
 * Check if a rule contains any condition fields that depend on transcode state.
 * Used to filter which rules need re-evaluation when transcode state changes mid-session.
 */
export function hasTranscodeConditions(rule: RuleV2): boolean {
  if (!rule.conditions?.groups) return false;
  return rule.conditions.groups.some((group) =>
    group.conditions.some((condition) => TRANSCODE_CONDITION_FIELDS.has(condition.field))
  );
}

/**
 * Condition fields whose evaluated value changes based on pause state/duration.
 * Rules containing these fields are re-evaluated on every poll cycle for paused sessions
 * because the pause duration grows over time even without state transitions.
 */
const PAUSE_CONDITION_FIELDS: ReadonlySet<ConditionField> = new Set([
  'current_pause_minutes',
  'total_pause_minutes',
]);

/**
 * Check if a rule contains any condition fields that depend on pause state.
 * Used to filter which rules need re-evaluation on each poll for paused sessions.
 */
export function hasPauseConditions(rule: RuleV2): boolean {
  if (!rule.conditions?.groups) return false;
  return rule.conditions.groups.some((group) =>
    group.conditions.some((condition) => PAUSE_CONDITION_FIELDS.has(condition.field))
  );
}

/**
 * Evaluate a single condition and return evidence.
 */
function evaluateCondition(context: EvaluationContext, condition: Condition): ConditionEvidence {
  const evaluator: ConditionEvaluator | undefined = evaluatorRegistry[condition.field];

  if (!evaluator) {
    logger.warn(`No evaluator found for condition field: ${condition.field}`, {
      field: condition.field,
    });
    return {
      field: condition.field,
      operator: condition.operator,
      threshold: condition.value,
      actual: null,
      matched: false,
    };
  }

  try {
    const result = evaluator(context, condition);
    // Handle sync and async evaluators
    if (result instanceof Promise) {
      logger.warn(`Async evaluator called synchronously for field: ${condition.field}`, {
        field: condition.field,
      });
      return {
        field: condition.field,
        operator: condition.operator,
        threshold: condition.value,
        actual: null,
        matched: false,
      };
    }
    return toConditionEvidence(condition, result);
  } catch (error) {
    logger.error(`Error evaluating condition field ${condition.field}`, {
      field: condition.field,
      error,
    });
    return {
      field: condition.field,
      operator: condition.operator,
      threshold: condition.value,
      actual: null,
      matched: false,
    };
  }
}

/**
 * Convert an evaluator result to condition evidence.
 */
function toConditionEvidence(condition: Condition, result: EvaluatorResult): ConditionEvidence {
  const evidence: ConditionEvidence = {
    field: condition.field,
    operator: condition.operator,
    threshold: condition.value,
    actual: result.actual,
    matched: result.matched,
  };
  if (result.relatedSessionIds?.length) {
    evidence.relatedSessionIds = result.relatedSessionIds;
  }
  if (result.details && Object.keys(result.details).length > 0) {
    evidence.details = result.details;
  }
  return evidence;
}

interface GroupResult {
  matched: boolean;
  conditions: ConditionEvidence[];
}

/**
 * Evaluate a condition group (conditions within a group are OR'd).
 * Evaluates ALL conditions to collect full evidence.
 */
function evaluateConditionGroup(context: EvaluationContext, group: ConditionGroup): GroupResult {
  if (group.conditions.length === 0) {
    return { matched: true, conditions: [] };
  }

  // Evaluate ALL conditions (no short-circuit) to collect full evidence
  const conditions = group.conditions.map((condition) => evaluateCondition(context, condition));

  // OR logic - any condition matching makes the group true
  const matched = conditions.some((c) => c.matched);

  return { matched, conditions };
}

interface AllGroupsResult {
  matchedGroups: number[] | null;
  evidence: GroupEvidence[];
}

/**
 * Evaluate all condition groups (groups are AND'd together).
 * Returns evidence for all evaluated groups.
 */
function evaluateAllGroups(
  context: EvaluationContext,
  conditions: RuleConditions
): AllGroupsResult {
  if (conditions.groups.length === 0) {
    return { matchedGroups: [], evidence: [] };
  }

  const matchedGroups: number[] = [];
  const evidence: GroupEvidence[] = [];

  // AND logic - all groups must match
  for (let i = 0; i < conditions.groups.length; i++) {
    const group = conditions.groups[i];
    if (!group) continue;

    const groupResult = evaluateConditionGroup(context, group);
    evidence.push({
      groupIndex: i,
      matched: groupResult.matched,
      conditions: groupResult.conditions,
    });

    if (!groupResult.matched) {
      return { matchedGroups: null, evidence }; // Any group failing = rule doesn't match
    }
    matchedGroups.push(i);
  }

  return { matchedGroups, evidence };
}

/**
 * Evaluate a single rule against the given context.
 */
export function evaluateRule(context: EvaluationContext): EvaluationResult {
  const { rule } = context;

  // Check if rule has v2 conditions
  if (!rule.conditions?.groups) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      matchedGroups: [],
      actions: [],
    };
  }

  const { matchedGroups, evidence } = evaluateAllGroups(context, rule.conditions);
  const matched = matchedGroups !== null;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched,
    matchedGroups: matchedGroups ?? [],
    actions: matched ? (rule.actions?.actions ?? []) : [],
    evidence: matched ? evidence : undefined,
  };
}

/**
 * Evaluate multiple rules against the given session context.
 * Returns all matching rules with their actions.
 */
export function evaluateRules(
  baseContext: Omit<EvaluationContext, 'rule'>,
  rules: RuleV2[]
): EvaluationResult[] {
  const results: EvaluationResult[] = [];

  for (const rule of rules) {
    // Skip inactive rules
    if (!rule.isActive) {
      continue;
    }

    // Check server scope - if rule is server-specific, must match context server
    if (rule.serverId && rule.serverId !== baseContext.server.id) {
      continue;
    }

    const context: EvaluationContext = {
      ...baseContext,
      rule,
    };

    const result = evaluateRule(context);

    // Only include rules that matched
    if (result.matched) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Async version of evaluateCondition.
 */
async function evaluateConditionAsync(
  context: EvaluationContext,
  condition: Condition
): Promise<ConditionEvidence> {
  const evaluator: ConditionEvaluator | undefined = evaluatorRegistry[condition.field];

  if (!evaluator) {
    logger.warn(`No evaluator found for condition field: ${condition.field}`, {
      field: condition.field,
    });
    return {
      field: condition.field,
      operator: condition.operator,
      threshold: condition.value,
      actual: null,
      matched: false,
    };
  }

  try {
    const result = evaluator(context, condition);
    // Handle both sync and async evaluators
    const resolved = result instanceof Promise ? await result : result;
    return toConditionEvidence(condition, resolved);
  } catch (error) {
    logger.error(`Error evaluating condition field ${condition.field}`, {
      field: condition.field,
      error,
    });
    return {
      field: condition.field,
      operator: condition.operator,
      threshold: condition.value,
      actual: null,
      matched: false,
    };
  }
}

/**
 * Async version of evaluateConditionGroup.
 */
async function evaluateConditionGroupAsync(
  context: EvaluationContext,
  group: ConditionGroup
): Promise<GroupResult> {
  if (group.conditions.length === 0) {
    return { matched: true, conditions: [] };
  }

  // Evaluate all conditions in parallel, collecting full evidence
  const conditions = await Promise.all(
    group.conditions.map((condition) => evaluateConditionAsync(context, condition))
  );

  return { matched: conditions.some((c) => c.matched), conditions };
}

/**
 * Async version of evaluateAllGroups.
 */
async function evaluateAllGroupsAsync(
  context: EvaluationContext,
  conditions: RuleConditions
): Promise<AllGroupsResult> {
  if (conditions.groups.length === 0) {
    return { matchedGroups: [], evidence: [] };
  }

  const matchedGroups: number[] = [];
  const evidence: GroupEvidence[] = [];

  // Evaluate groups sequentially (AND logic requires early exit on failure)
  for (let i = 0; i < conditions.groups.length; i++) {
    const group = conditions.groups[i];
    if (!group) continue;

    const groupResult = await evaluateConditionGroupAsync(context, group);
    evidence.push({
      groupIndex: i,
      matched: groupResult.matched,
      conditions: groupResult.conditions,
    });

    if (!groupResult.matched) {
      return { matchedGroups: null, evidence };
    }
    matchedGroups.push(i);
  }

  return { matchedGroups, evidence };
}

/**
 * Async version of evaluateRule.
 */
export async function evaluateRuleAsync(context: EvaluationContext): Promise<EvaluationResult> {
  const { rule } = context;

  if (!rule.conditions?.groups) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: false,
      matchedGroups: [],
      actions: [],
    };
  }

  const { matchedGroups, evidence } = await evaluateAllGroupsAsync(context, rule.conditions);
  const matched = matchedGroups !== null;

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    matched,
    matchedGroups: matchedGroups ?? [],
    actions: matched ? (rule.actions?.actions ?? []) : [],
    evidence: matched ? evidence : undefined,
  };
}

/**
 * Async version of evaluateRules.
 */
export async function evaluateRulesAsync(
  baseContext: Omit<EvaluationContext, 'rule'>,
  rules: RuleV2[]
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];

  for (const rule of rules) {
    if (!rule.isActive) {
      continue;
    }

    if (rule.serverId && rule.serverId !== baseContext.server.id) {
      continue;
    }

    const context: EvaluationContext = {
      ...baseContext,
      rule,
    };

    const result = await evaluateRuleAsync(context);

    if (result.matched) {
      results.push(result);
    }
  }

  return results;
}
