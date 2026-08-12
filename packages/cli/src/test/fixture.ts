import { parse as parseYaml } from "yaml";
import type { ComposedState, Input } from "@rpg-harness/engine";

export type Assertion =
  | ReasonAssertion
  | StateAssertion
  | OutputAssertion
  | ActivityAssertion
  | StatAssertion
  | ResourceAssertion;

export interface ReasonAssertion {
  kind: "reason";
  eq: string;
}

export interface StateAssertion {
  kind: "state";
  path: string;
  eq?: unknown;
  gte?: number;
  lte?: number;
  includes?: unknown;
  length?: number;
}

export interface OutputAssertion {
  kind: "output";
  type: string;
  present: boolean;
  speaker?: string;
  textIncludes?: string;
}

// Inspect the most recent hubMenu Output for a specific activity by id.
// If no hubMenu was ever yielded the assertion fails with a clear
// message. Use `available` / `lockedReasonIncludes` to verify the
// gating + reason plumbing; omit `present` if the activity should
// just exist regardless of available state.
export interface ActivityAssertion {
  kind: "activity";
  id: string;
  present?: boolean;
  available?: boolean;
  lockedReasonIncludes?: string;
  titleIncludes?: string;
  forecastMetric?: string;
  metricValue?: number;
  metricMin?: number;
  metricMax?: number;
}

// Inspect the most recent hubMenu Output's stats[] for a specific
// row by id. Use this to verify modules surfaced their custom stats
// (pulse_*, companion_hp, etc.) without diving into snapshot shape.
export interface StatAssertion {
  kind: "stat";
  id: string;
  present?: boolean;
  value?: number;
}

// Inspect a structured resource group on the most recent hubMenu. This keeps
// transient inventories (carried loot, quest materials, etc.) testable through
// the same public contract consumed by human and AI frontends.
export interface ResourceAssertion {
  kind: "resource";
  groupId: string;
  id: string;
  present?: boolean;
  quantity?: number;
}

export interface Fixture {
  name: string;
  description?: string;
  state?: Partial<ComposedState>;
  inputs: Input[];
  assertions: Assertion[];
  maxSteps?: number;
}

export class FixtureParseError extends Error {}

export function parseFixture(content: string, source?: string): Fixture {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new FixtureParseError(
      `${source ?? "fixture"}: invalid YAML — ${(err as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new FixtureParseError(
      `${source ?? "fixture"}: must be a YAML object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string") {
    throw new FixtureParseError(`${source ?? "fixture"}: missing \`name\``);
  }
  if (!Array.isArray(obj.inputs)) {
    throw new FixtureParseError(
      `${source ?? "fixture"}: \`inputs\` must be an array`,
    );
  }
  if (!Array.isArray(obj.assertions)) {
    throw new FixtureParseError(
      `${source ?? "fixture"}: \`assertions\` must be an array`,
    );
  }
  const fixture: Fixture = {
    name: obj.name,
    inputs: obj.inputs as Input[],
    assertions: obj.assertions as Assertion[],
  };
  if (typeof obj.description === "string") fixture.description = obj.description;
  if (obj.state && typeof obj.state === "object") {
    fixture.state = expandSeedSugar(obj.state as Partial<ComposedState>);
  }
  if (typeof obj.maxSteps === "number") fixture.maxSteps = obj.maxSteps;
  return fixture;
}

// Fixture-loader sugar. The engine state shape doesn't have a flat
// `completedScripts: string[]` field anymore (Phase 2: it's
// `scripts: Record<id, ScriptState>` + `completionOrder: string[]`).
// To keep test fixtures readable, the loader accepts the legacy
// shorthand `baseline.completedScripts: [a, b, c]` and expands it
// into the new shape before merging into the engine's initial state.
// Authors writing new fixtures can use either form.
function expandSeedSugar(
  raw: Partial<ComposedState>,
): Partial<ComposedState> {
  const baseline = (raw as { baseline?: Record<string, unknown> }).baseline;
  if (!baseline) return raw;
  const next: Record<string, unknown> = { ...baseline };

  // Phase 2 legacy: `completedScripts: [a, b]` → scripts + completionOrder
  const legacyList = baseline.completedScripts;
  if (Array.isArray(legacyList)) {
    const scriptsRecord: Record<string, unknown> = {
      ...((baseline.scripts as Record<string, unknown>) ?? {}),
    };
    for (const id of legacyList) {
      if (typeof id === "string" && !scriptsRecord[id]) {
        scriptsRecord[id] = {
          completed: true,
          selfSwitches: { A: false, B: false, C: false, D: false },
        };
      }
    }
    const order = Array.isArray(baseline.completionOrder)
      ? [...(baseline.completionOrder as unknown[])]
      : [];
    for (const id of legacyList) {
      if (typeof id === "string" && !order.includes(id)) order.push(id);
    }
    next.scripts = scriptsRecord;
    next.completionOrder = order;
    delete next.completedScripts;
  }

  // Phase 3 legacy: `characters.<id>.affection: N` →
  // `characters.<id>.stats.affection: N`
  const chars = baseline.characters as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (chars) {
    const rewritten: Record<string, Record<string, unknown>> = {};
    for (const [id, cs] of Object.entries(chars)) {
      if (cs && typeof cs === "object" && "affection" in cs) {
        const { affection, stats, ...rest } = cs as {
          affection?: unknown;
          stats?: Record<string, unknown>;
        };
        rewritten[id] = {
          ...rest,
          stats: { ...(stats ?? {}), affection },
        };
      } else {
        rewritten[id] = cs;
      }
    }
    next.characters = rewritten;
  }

  return { ...raw, baseline: next } as unknown as Partial<ComposedState>;
}

export function mergeState(
  base: ComposedState,
  overrides: Partial<ComposedState> | undefined,
): ComposedState {
  if (!overrides) return base;
  const result = structuredClone(base);
  for (const [ns, slice] of Object.entries(overrides)) {
    const existing = (result as Record<string, unknown>)[ns];
    if (
      existing &&
      typeof existing === "object" &&
      slice &&
      typeof slice === "object" &&
      !Array.isArray(slice) &&
      !Array.isArray(existing)
    ) {
      (result as Record<string, unknown>)[ns] = deepMerge(
        existing as Record<string, unknown>,
        slice as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[ns] = slice as unknown;
    }
  }
  return result;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      result[k] &&
      typeof result[k] === "object" &&
      !Array.isArray(result[k])
    ) {
      result[k] = deepMerge(
        result[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}
