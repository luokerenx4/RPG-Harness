import { loadGame } from "../loader";
import { collectAiPersonas } from "../test/personas";

export interface AiPersonaSummary {
  name: string;
  description: string;
  deterministic: boolean;
  source: "builtin" | `module:${string}`;
}

export async function collectAiPersonaSummaries(
  gameDir: string,
): Promise<AiPersonaSummary[]> {
  const registry = collectAiPersonas(await loadGame(gameDir));
  return Object.entries(registry)
    .map(([name, persona]) => ({
      name,
      description: persona.description,
      deterministic: persona.deterministic !== false,
      source: persona.source,
    }))
    .sort((left, right) =>
      Number(right.source.startsWith("module:")) -
        Number(left.source.startsWith("module:")) ||
      left.name.localeCompare(right.name)
    );
}

export async function personasCommand(args: {
  gameDir: string;
  pretty: boolean;
}): Promise<void> {
  const personas = await collectAiPersonaSummaries(args.gameDir);
  process.stdout.write(
    (args.pretty ? JSON.stringify(personas, null, 2) : JSON.stringify(personas)) +
      "\n",
  );
}
