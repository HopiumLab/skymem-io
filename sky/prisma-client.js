/**
 * Shared Prisma Client — ONE instance for the entire Sky system.
 *
 * Every module imports from here instead of creating its own PrismaClient.
 * Each PrismaClient opens its own connection pool (default 5 connections),
 * so 20+ modules = 100+ connections = MySQL connection limit exceeded.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;
