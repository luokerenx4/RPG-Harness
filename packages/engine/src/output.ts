import type { HubObjectiveSnapshot, Output } from "./types";

export class OutputContractError extends Error {
  constructor(message: string) {
    super(`Invalid engine output: ${message}`);
    this.name = "OutputContractError";
  }
}

/**
 * Fail fast when a custom preset/module publishes AI-facing semantics that
 * clients cannot safely consume. TypeScript catches this for in-repo authors;
 * this boundary also protects dynamically loaded JavaScript and generated code.
 */
export function validateOutput(output: Output): void {
  if (output.type === "gameEnd") {
    if (
      output.endingId !== undefined &&
      (typeof output.endingId !== "string" ||
        output.endingId.length === 0 ||
        output.endingId !== output.endingId.trim())
    ) {
      throw new OutputContractError(
        "gameEnd endingId must be a non-empty, trimmed string when present",
      );
    }
    return;
  }
  if (output.type !== "hubMenu" || output.snapshot.objectives === undefined) return;
  const activityIds = new Set(output.snapshot.activities.map((activity) => activity.id));
  const objectiveIds = new Set<string>();
  for (const objective of output.snapshot.objectives) {
    validateObjective(objective, objectiveIds, activityIds);
    objectiveIds.add(objective.id);
  }
}

function validateObjective(
  objective: HubObjectiveSnapshot,
  objectiveIds: Set<string>,
  activityIds: Set<string>,
): void {
  if (typeof objective.id !== "string" || objective.id.length === 0) {
    throw new OutputContractError("hub objective id must be a non-empty string");
  }
  if (objectiveIds.has(objective.id)) {
    throw new OutputContractError(`duplicate hub objective id "${objective.id}"`);
  }
  if (!["main", "side", "mastery"].includes(objective.scope)) {
    throw new OutputContractError(
      `hub objective "${objective.id}" has invalid scope ${String(objective.scope)}`,
    );
  }
  if (typeof objective.terminal !== "boolean") {
    throw new OutputContractError(
      `hub objective "${objective.id}" must declare terminal as a boolean`,
    );
  }
  if (!["active", "completed", "blocked"].includes(objective.status)) {
    throw new OutputContractError(
      `hub objective "${objective.id}" has invalid status ${String(objective.status)}`,
    );
  }
  const related = objective.relatedActivityIds ?? [];
  if (new Set(related).size !== related.length) {
    throw new OutputContractError(
      `hub objective "${objective.id}" contains duplicate related activity ids`,
    );
  }
  const missing = related.filter((id) => !activityIds.has(id));
  if (missing.length > 0) {
    throw new OutputContractError(
      `hub objective "${objective.id}" references activities not present in the same hub: ${missing.join(", ")}`,
    );
  }
  const requirementIds = new Set<string>();
  for (const requirement of objective.requirements ?? []) {
    if (requirementIds.has(requirement.id)) {
      throw new OutputContractError(
        `hub objective "${objective.id}" contains duplicate requirement id "${requirement.id}"`,
      );
    }
    requirementIds.add(requirement.id);
  }
}
