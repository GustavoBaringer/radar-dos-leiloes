import { IdentityService } from '../application/services/identity/identity.service.js';
import { IdentityRepository } from '../infra/database/repositories/identity.repository.js';

/** Shared by native HTTP and legacy compatibility exports; importing does not connect to DB. */
export const defaultIdentityService = new IdentityService(new IdentityRepository());
