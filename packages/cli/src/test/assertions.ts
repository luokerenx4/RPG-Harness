import type { LoopResult, Output } from "@rpg-harness/engine";
import type { Assertion } from "./fixture";

export interface AssertionFailure {
  index: number;
  assertion: Assertion;
  message: string;
}

export function runAssertions(
  result: LoopResult,
  assertions: Assertion[],
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i];
    if (!a) continue;
    const failure = checkAssertion(result, a);
    if (failure) failures.push({ index: i, assertion: a, message: failure });
  }
  return failures;
}

function checkAssertion(result: LoopResult, a: Assertion): string | null {
  switch (a.kind) {
    case "reason":
      if (result.reason !== a.eq) {
        return `expected reason=${a.eq}, got ${result.reason}${
          result.error ? ` (error: ${result.error})` : ""
        }`;
      }
      return null;
    case "state":
      return checkState(result, a);
    case "output":
      return checkOutput(result.trace.map((t) => t.output), a);
    case "activity":
      return checkActivity(result.trace.map((t) => t.output), a);
    case "stat":
      return checkStat(result.trace.map((t) => t.output), a);
    case "resource":
      return checkResource(result.trace.map((t) => t.output), a);
    case "objective":
      return checkObjective(result.trace.map((t) => t.output), a);
  }
}

function checkObjective(
  outputs: Output[],
  a: Extract<Assertion, { kind: "objective" }>,
): string | null {
  const snap = lastHubSnapshot(outputs);
  if (!snap) return `objective ${a.id}: no hubMenu output in trace`;
  const objective = (snap.objectives ?? []).find((item) => item.id === a.id);
  const present = a.present ?? true;
  if (!objective) {
    return present
      ? `objective ${a.id}: not found in hubMenu.objectives`
      : null;
  }
  if (!present) return `objective ${a.id}: expected absent but present`;
  if (a.status !== undefined && objective.status !== a.status) {
    return `objective ${a.id}: expected status=${a.status}, got ${objective.status}`;
  }
  if (a.scope !== undefined && objective.scope !== a.scope) {
    return `objective ${a.id}: expected scope=${a.scope}, got ${objective.scope}`;
  }
  if (a.terminal !== undefined && objective.terminal !== a.terminal) {
    return `objective ${a.id}: expected terminal=${a.terminal}, got ${objective.terminal}`;
  }
  if (a.focus !== undefined && objective.focus !== a.focus) {
    return `objective ${a.id}: expected focus=${a.focus}, got ${String(objective.focus)}`;
  }
  if (a.titleIncludes !== undefined && !objective.title.includes(a.titleIncludes)) {
    return `objective ${a.id}: expected title to include "${a.titleIncludes}", got "${objective.title}"`;
  }
  if (
    a.descriptionIncludes !== undefined &&
    !(objective.description ?? "").includes(a.descriptionIncludes)
  ) {
    return `objective ${a.id}: expected description to include "${a.descriptionIncludes}", got "${objective.description ?? ""}"`;
  }
  if (
    a.relatedActivityIncludes !== undefined &&
    !(objective.relatedActivityIds ?? []).includes(a.relatedActivityIncludes)
  ) {
    return `objective ${a.id}: expected relatedActivityIds to include ${a.relatedActivityIncludes}`;
  }
  if (
    a.relatedActivityExcludes !== undefined &&
    (objective.relatedActivityIds ?? []).includes(a.relatedActivityExcludes)
  ) {
    return `objective ${a.id}: expected relatedActivityIds to exclude ${a.relatedActivityExcludes}`;
  }
  if (a.requirementId !== undefined) {
    const req = (objective.requirements ?? []).find((item) => item.id === a.requirementId);
    if (!req) return `objective ${a.id}: requirement ${a.requirementId} not found`;
    if (a.current !== undefined && req.current !== a.current) {
      return `objective ${a.id}/${a.requirementId}: expected current=${String(a.current)}, got ${String(req.current)}`;
    }
    if (a.target !== undefined && req.target !== a.target) {
      return `objective ${a.id}/${a.requirementId}: expected target=${String(a.target)}, got ${String(req.target)}`;
    }
    if (a.satisfied !== undefined && req.satisfied !== a.satisfied) {
      return `objective ${a.id}/${a.requirementId}: expected satisfied=${a.satisfied}, got ${req.satisfied}`;
    }
  }
  return null;
}

function checkResource(
  outputs: Output[],
  a: Extract<Assertion, { kind: "resource" }>,
): string | null {
  const snap = lastHubSnapshot(outputs);
  if (!snap) {
    return `resource ${a.groupId}/${a.id}: no hubMenu output in trace`;
  }
  const group = (snap.resourceGroups ?? []).find(
    (item) => item.id === a.groupId,
  );
  const resource = group?.resources.find((item) => item.id === a.id);
  const present = a.present ?? true;
  if (!resource) {
    return present
      ? `resource ${a.groupId}/${a.id}: not found in hubMenu.resourceGroups`
      : null;
  }
  if (!present) {
    return `resource ${a.groupId}/${a.id}: expected absent but present`;
  }
  if (a.quantity !== undefined && resource.quantity !== a.quantity) {
    return `resource ${a.groupId}/${a.id}: expected quantity=${a.quantity}, got ${resource.quantity}`;
  }
  return null;
}

function lastHubSnapshot(outputs: Output[]) {
  for (let i = outputs.length - 1; i >= 0; i--) {
    const o = outputs[i];
    if (o && o.type === "hubMenu") return o.snapshot;
  }
  return null;
}

function checkActivity(
  outputs: Output[],
  a: Extract<Assertion, { kind: "activity" }>,
): string | null {
  const snap = lastHubSnapshot(outputs);
  if (!snap) return `activity ${a.id}: no hubMenu output in trace`;
  const act = snap.activities.find((x) => x.id === a.id);
  const present = a.present ?? true;
  if (!act) {
    return present
      ? `activity ${a.id}: not found in hubMenu (activities: ${snap.activities.map((x) => x.id).join(", ")})`
      : null;
  }
  if (!present) {
    return `activity ${a.id}: expected absent but present`;
  }
  if (a.available !== undefined && act.available !== a.available) {
    return `activity ${a.id}: expected available=${a.available}, got ${act.available} (lockedReason=${act.lockedReason ?? "—"})`;
  }
  if (a.lockedReasonIncludes !== undefined) {
    const r = act.lockedReason ?? "";
    if (!r.includes(a.lockedReasonIncludes)) {
      return `activity ${a.id}: expected lockedReason to include "${a.lockedReasonIncludes}", got "${r}"`;
    }
  }
  if (a.titleIncludes !== undefined) {
    if (!act.title.includes(a.titleIncludes)) {
      return `activity ${a.id}: expected title to include "${a.titleIncludes}", got "${act.title}"`;
    }
  }
  if (
    a.descriptionIncludes !== undefined &&
    !(act.description ?? "").includes(a.descriptionIncludes)
  ) {
    return `activity ${a.id}: expected description to include "${a.descriptionIncludes}", got "${act.description ?? ""}"`;
  }
  if (
    a.effectsHintIncludes !== undefined &&
    !(act.effectsHint ?? "").includes(a.effectsHintIncludes)
  ) {
    return `activity ${a.id}: expected effectsHint to include "${a.effectsHintIncludes}", got "${act.effectsHint ?? ""}"`;
  }
  if (
    a.aiTagsIncludes !== undefined &&
    !(act.aiTags ?? []).includes(a.aiTagsIncludes)
  ) {
    return `activity ${a.id}: expected aiTags to include "${a.aiTagsIncludes}", got ${JSON.stringify(act.aiTags ?? [])}`;
  }
  if (
    a.aiTagsExcludes !== undefined &&
    (act.aiTags ?? []).includes(a.aiTagsExcludes)
  ) {
    return `activity ${a.id}: expected aiTags to exclude "${a.aiTagsExcludes}", got ${JSON.stringify(act.aiTags ?? [])}`;
  }
  if (a.recommended !== undefined && act.recommended !== a.recommended) {
    return `activity ${a.id}: expected recommended=${a.recommended}, got ${String(act.recommended)}`;
  }
  if (a.requires !== undefined && !deepEqual(act.requires, a.requires)) {
    return `activity ${a.id}: expected requires=${JSON.stringify(a.requires)}, got ${JSON.stringify(act.requires)}`;
  }
  if (a.forecastMetric !== undefined) {
    const metric = act.forecast?.metrics.find(
      (item) => item.id === a.forecastMetric,
    );
    const metricPresent = a.forecastMetricPresent ?? true;
    if (!metric) {
      return metricPresent
        ? `activity ${a.id}: forecast metric ${a.forecastMetric} not found`
        : null;
    }
    if (!metricPresent) {
      return `activity ${a.id}: forecast metric ${a.forecastMetric} expected absent but present`;
    }
    if (a.metricValue !== undefined && metric.value !== a.metricValue) {
      return `activity ${a.id}: metric ${a.forecastMetric} expected value=${a.metricValue}, got ${String(metric.value)}`;
    }
    if (a.metricMin !== undefined && metric.min !== a.metricMin) {
      return `activity ${a.id}: metric ${a.forecastMetric} expected min=${a.metricMin}, got ${String(metric.min)}`;
    }
    if (a.metricMax !== undefined && metric.max !== a.metricMax) {
      return `activity ${a.id}: metric ${a.forecastMetric} expected max=${a.metricMax}, got ${String(metric.max)}`;
    }
    if (
      a.metricPlayerDisplay !== undefined &&
      (metric.playerDisplay ?? "primary") !== a.metricPlayerDisplay
    ) {
      return `activity ${a.id}: metric ${a.forecastMetric} expected playerDisplay=${a.metricPlayerDisplay}, got ${metric.playerDisplay ?? "primary"}`;
    }
  }
  return null;
}

function checkStat(
  outputs: Output[],
  a: Extract<Assertion, { kind: "stat" }>,
): string | null {
  const snap = lastHubSnapshot(outputs);
  if (!snap) return `stat ${a.id}: no hubMenu output in trace`;
  const row = snap.stats.find((x) => x.id === a.id);
  const present = a.present ?? true;
  if (!row) {
    return present
      ? `stat ${a.id}: not found in hubMenu.stats (ids: ${snap.stats.map((x) => x.id).join(", ")})`
      : null;
  }
  if (!present) {
    return `stat ${a.id}: expected absent but present`;
  }
  if (a.value !== undefined && row.value !== a.value) {
    return `stat ${a.id}: expected value=${a.value}, got ${row.value}`;
  }
  return null;
}

function checkState(
  result: LoopResult,
  a: Extract<Assertion, { kind: "state" }>,
): string | null {
  const value = readPath(result.finalState, a.path);
  if (a.eq !== undefined && !deepEqual(value, a.eq)) {
    return `state.${a.path}: expected ${JSON.stringify(a.eq)}, got ${JSON.stringify(value)}`;
  }
  if (a.gte !== undefined) {
    if (typeof value !== "number" || value < a.gte) {
      return `state.${a.path}: expected >= ${a.gte}, got ${JSON.stringify(value)}`;
    }
  }
  if (a.lte !== undefined) {
    if (typeof value !== "number" || value > a.lte) {
      return `state.${a.path}: expected <= ${a.lte}, got ${JSON.stringify(value)}`;
    }
  }
  if (a.includes !== undefined) {
    if (!Array.isArray(value) || !value.some((v) => deepEqual(v, a.includes))) {
      return `state.${a.path}: expected to include ${JSON.stringify(a.includes)}, got ${JSON.stringify(value)}`;
    }
  }
  if (a.length !== undefined) {
    const len = Array.isArray(value)
      ? value.length
      : typeof value === "string"
        ? value.length
        : null;
    if (len === null) {
      return `state.${a.path}: expected length but value is not array/string: ${JSON.stringify(value)}`;
    }
    if (len !== a.length) {
      return `state.${a.path}: expected length ${a.length}, got ${len}`;
    }
  }
  return null;
}

function checkOutput(
  outputs: Output[],
  a: Extract<Assertion, { kind: "output" }>,
): string | null {
  const matches = outputs.filter((o) => {
    if (o.type !== a.type) return false;
    if (a.speaker !== undefined) {
      if (o.type !== "dialogue") return false;
      if (o.speakerId !== a.speaker) return false;
    }
    if (a.textIncludes !== undefined) {
      const text =
        o.type === "narration"
          ? o.text
          : o.type === "dialogue"
            ? o.text
            : null;
      if (typeof text !== "string" || !text.includes(a.textIncludes)) {
        return false;
      }
    }
    if (a.optionTextIncludes !== undefined) {
      if (o.type !== "choice") return false;
      if (a.choiceId !== undefined && o.choiceId !== a.choiceId) return false;
      const option = o.options.find((item) =>
        item.text.includes(a.optionTextIncludes!) &&
        (a.optionId === undefined || item.id === a.optionId),
      );
      if (!option) return false;
      if (
        a.optionAiPriority !== undefined &&
        option.aiPriority !== a.optionAiPriority
      ) {
        return false;
      }
      if (
        a.optionAiTagsIncludes !== undefined &&
        !option.aiTags?.includes(a.optionAiTagsIncludes)
      ) {
        return false;
      }
      if (
        a.optionAvailable !== undefined &&
        option.available !== a.optionAvailable
      ) {
        return false;
      }
      if (
        a.optionLockedReasonIncludes !== undefined &&
        !option.lockedReason?.includes(a.optionLockedReasonIncludes)
      ) {
        return false;
      }
      if (
        a.optionRequires !== undefined &&
        JSON.stringify(option.requires) !== JSON.stringify(a.optionRequires)
      ) {
        return false;
      }
    }
    return true;
  });
  const found = matches.length > 0;
  if (a.present && !found) {
    return `expected at least one output matching type=${a.type}${
      a.textIncludes ? ` textIncludes=${a.textIncludes}` : ""
    }${
      a.optionTextIncludes
        ? ` choiceId=${String(a.choiceId)} optionId=${String(a.optionId)} optionTextIncludes=${a.optionTextIncludes} optionAiPriority=${String(a.optionAiPriority)} optionAiTagsIncludes=${String(a.optionAiTagsIncludes)} optionAvailable=${String(a.optionAvailable)} optionLockedReasonIncludes=${String(a.optionLockedReasonIncludes)} optionRequires=${JSON.stringify(a.optionRequires)}`
        : ""
    }`;
  }
  if (!a.present && found) {
    return `expected no output matching type=${a.type}${
      a.textIncludes ? ` textIncludes=${a.textIncludes}` : ""
    }${
      a.optionTextIncludes
        ? ` choiceId=${String(a.choiceId)} optionId=${String(a.optionId)} optionTextIncludes=${a.optionTextIncludes} optionAiPriority=${String(a.optionAiPriority)} optionAiTagsIncludes=${String(a.optionAiTagsIncludes)} optionAvailable=${String(a.optionAvailable)} optionLockedReasonIncludes=${String(a.optionLockedReasonIncludes)} optionRequires=${JSON.stringify(a.optionRequires)}`
        : ""
    }, but found ${matches.length}`;
  }
  return null;
}

function readPath(obj: unknown, path: string): unknown {
  // Phase 2 legacy-path alias: `baseline.completedScripts` now lives at
  // `baseline.completionOrder`. Phase 3 legacy-path alias:
  // `baseline.characters.<id>.affection` now lives at
  // `baseline.characters.<id>.stats.affection`. Existing fixtures keep
  // working until they're rewritten.
  if (path === "baseline.completedScripts") {
    return readPath(obj, "baseline.completionOrder");
  }
  const charAffectionMatch = path.match(
    /^baseline\.characters\.([^.]+)\.affection$/,
  );
  if (charAffectionMatch) {
    return readPath(
      obj,
      `baseline.characters.${charAffectionMatch[1]}.stats.affection`,
    );
  }
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const p of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((k) => deepEqual(ao[k], bo[k]));
}
