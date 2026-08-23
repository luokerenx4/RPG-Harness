export class MapTopologyError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = status === 409 ? "map_topology_conflict" : "invalid_map_topology",
  ) {
    super(message);
  }
}
