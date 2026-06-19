import type { ParleySettings } from '../config/settings';
import type { Logger } from '../logging/logger';
import { ParleyAuthStore } from './auth';
import { ParleyClient } from './ParleyClient';
import type { ParleyProvider } from './ParleyProvider';

export function createParleyProvider(settings: ParleySettings, auth: ParleyAuthStore, logger: Logger): ParleyProvider {
  return new ParleyClient(settings.endpoint, auth, logger, settings.defaultAgent);
}
