import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import assert from 'node:assert';
import console from 'node:console';
import process from 'node:process';
import { authFactory } from '../libs/api/auth/src/lib/auth-factory';
import { PrismaClient } from '../libs/database/src';

assert(process.env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET is not set');
assert(process.env.BETTER_AUTH_URL, 'BETTER_AUTH_URL is not set');
assert(process.env.DATABASE_URL, 'DATABASE_URL is not set');

process.env.USE_EMAIL_PASSWORD_AUTH = 'true';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  }),
});

export const auth = authFactory(prisma);
console.log('BetterAuth initialized', auth);
