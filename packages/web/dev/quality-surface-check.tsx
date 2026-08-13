import { createHash } from "node:crypto";
import React, { type ReactElement, type ReactNode } from "react";
import type { Game, Input } from "@rpg-harness/engine";
import { StageView } from "../src/WebPlayScreen";

export interface WebQualitySurfaceEvidence {
  schemaVersion: 1;
  id: "web-input-contract";
  status: "passed";
  revision: string;
  interactions: Array<{
    surface: "narration" | "choice" | "hub-activity" | "script-select";
    input: Input;
  }>;
}

/** Execute the current React controls and prove their renderer-neutral inputs. */
export function runWebQualitySurfaceCheck(): WebQualitySurfaceEvidence {
  const observed: Array<WebQualitySurfaceEvidence["interactions"][number]> = [];
  const game = { scripts: [] } as unknown as Game;
  const cases = [
    {
      surface: "narration" as const,
      stage: { kind: "narration" as const, text: "Continue." },
      control: "Continue.",
      expected: { type: "next" } as const,
    },
    {
      surface: "choice" as const,
      stage: {
        kind: "choice" as const,
        cursor: 0,
        scriptId: "route-script",
        choiceId: "route",
        options: [{ id: "friends", text: "Friends", available: true }],
      },
      control: "Friends",
      expected: { type: "choose", choiceId: "route", optionId: "friends" } as const,
    },
    {
      surface: "hub-activity" as const,
      stage: {
        kind: "hubMenu" as const,
        cursor: 0,
        snapshot: {
          day: 1,
          maxDay: 1,
          slot: 0,
          slotName: "",
          stats: [],
          affections: [],
          activities: [{
            id: "invite:kasumi",
            kind: "action" as const,
            title: "Invite Kasumi",
            description: "",
            category: "social",
            cost: 0,
            available: true,
          }],
        },
      },
      control: "Invite Kasumi",
      expected: { type: "doActivity", id: "invite:kasumi" } as const,
    },
    {
      surface: "script-select" as const,
      stage: {
        kind: "scriptComplete" as const,
        cursor: 0,
        completedId: "intro",
        nextAvailable: [{ id: "ending", title: "Ending" }],
      },
      control: "Ending",
      expected: { type: "select", scriptId: "ending" } as const,
    },
  ];

  for (const entry of cases) {
    const inputs: Input[] = [];
    const tree = StageView({
      stage: entry.stage,
      game,
      onInput: (input) => inputs.push(input),
    });
    const control = findElement(tree, (element) =>
      typeof element.props.onClick === "function" &&
      nodeText(element.props.children).includes(entry.control)
    );
    if (!control) {
      throw new Error(`Web quality surface is missing ${entry.surface} control`);
    }
    (control.props.onClick as () => void)();
    if (JSON.stringify(inputs) !== JSON.stringify([entry.expected])) {
      throw new Error(
        `Web quality surface ${entry.surface} dispatched ${JSON.stringify(inputs)}; expected ${JSON.stringify([entry.expected])}`,
      );
    }
    observed.push({ surface: entry.surface, input: inputs[0]! });
  }

  const revision = createHash("sha256")
    .update(JSON.stringify(observed))
    .digest("hex");
  return {
    schemaVersion: 1,
    id: "web-input-contract",
    status: "passed",
    revision,
    interactions: observed,
  };
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children as ReactNode)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!React.isValidElement<Record<string, unknown>>(node)) {
    return React.Children.toArray(node).map(nodeText).join("");
  }
  return nodeText(node.props.children as ReactNode);
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(runWebQualitySurfaceCheck()) + "\n");
}
