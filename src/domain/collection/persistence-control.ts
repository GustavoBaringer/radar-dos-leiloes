export interface PersistenceControl {
  signal?: AbortSignal;
  authorizePersistence?: () => void | Promise<void>;
}
