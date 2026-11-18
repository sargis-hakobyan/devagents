/**
 * The models an engine reports for the signed-in account, read only when someone asks for it.
 * Listing is not proof of access: only a run shows that a model answers.
 */
export type EngineModel = { id: string; name: string };
/** `newIds` are the models that were not in the list loaded before this one; empty on the first load. */
export type ModelCatalog = { engine: string; models: EngineModel[]; loadedAt: string; newIds: string[] };
