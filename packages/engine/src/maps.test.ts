import { expect, test } from "bun:test";
import { collectMapConnections } from "./maps";

test("collectMapConnections projects placement map events as ordinary exits", () => {
  const connections = collectMapConnections({
    id: "gate",
    name: "Gate",
    description: "",
    placements: [{
      id: "north-door",
      at: { x: 2, y: 0 },
      z: 0,
      footprint: { width: 1, height: 1 },
      collision: "trigger",
      visible: true,
      resource: { kind: "map", id: "inner" },
      events: [{
        id: "move",
        trigger: "player_touch",
        label: "北へ進む",
        order: 0,
      }],
    }],
  });
  expect(connections).toEqual([{ dir: "北へ進む", target: "inner" }]);
});
