import { SetMetadata } from '@nestjs/common';
import type { PolicyHandler } from '../interfaces';

export const CHECK_POLICIES_KEY = 'check_policies';
export const CheckPolicies = (...args: PolicyHandler[]) => SetMetadata(CHECK_POLICIES_KEY, args);
