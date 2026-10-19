import { CollectionService, type CollectionExecutionDependencies, type CollectionExecutionOptions } from './collection.service.js';

export * from './collection.service.js';

/** Compatibility for external callers/tests; production resolves the shared Nest service. */
export function executeCollection(options: CollectionExecutionOptions, deps: CollectionExecutionDependencies) {
  return new CollectionService(deps).execute(options);
}
