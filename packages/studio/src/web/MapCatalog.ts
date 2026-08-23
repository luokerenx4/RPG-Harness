import type { MapDef } from "@rpg-harness/engine";

export const STANDALONE_MAP_CHAIN = "";

export function normalizeMapChain(chain: string | undefined): string {
  // `MapDef.chain` is an authored runtime identity: parser validation and game
  // modules compare it byte-for-byte. Studio must not merge visually similar
  // chains by trimming their ids.
  return chain ?? STANDALONE_MAP_CHAIN;
}

export function mapCatalogChainKey(map: Pick<MapDef, "chain"> | undefined): string {
  return normalizeMapChain(map?.chain);
}

export function mapCatalogChainLabel(map: Pick<MapDef, "chain"> | undefined): string {
  return mapCatalogChainLabelFromKey(mapCatalogChainKey(map));
}

export function mapCatalogChainLabelFromKey(key: string): string {
  if (key === STANDALONE_MAP_CHAIN) return "Standalone";
  return key.trim() === key ? key : JSON.stringify(key);
}

export function compareMapCatalogChainKeys(left: string, right: string): number {
  if (left === STANDALONE_MAP_CHAIN) return right === STANDALONE_MAP_CHAIN ? 0 : -1;
  if (right === STANDALONE_MAP_CHAIN) return 1;
  return left.localeCompare(right);
}
