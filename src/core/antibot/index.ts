export { loadAntibotConfig, POLICIES, POLICY_IDS } from './config.js';
export { createAntibot } from './engine.js';
export type { Antibot, CreateAntibotOptions } from './engine.js';
export { registerAntibot } from './fastify.js';
export { normalizeClientIp } from './ip.js';
export { ROUTE_POLICIES } from './routes.js';
export { createImageService } from './images.js';
export type {
  ImageOutcome, ImagePlaceholderReason, ImageService, ImageServiceOptions,
  ImageLimits, ImageRequester, ImageRequestOptions, ImageRequestContext, ImageTransportResponse,
  ImageProcessor, ImageResponseBody, MissQuotaDecision,
} from './images.js';
export { createResourcePool, tryAcquireResource, tryAcquireImageJob } from './resources.js';
export type { ResourceLease, ResourcePool, ResourcePoolOptions } from './resources.js';
export type {
  AntibotConfig, AntibotEvent, AntibotObserver,
  Decision, DecisionReason, DecisionSource, Mode,
  Policy, PolicyId, RateLimitDriver, Subject,
} from './types.js';
export type { AntibotRequest, AntibotRegistration, RegisterAntibotOptions } from './fastify.js';
