import pino from 'pino';
import { createBot } from './bot.js';
import { parseConfig } from './config.js';
import { prisma } from './database.js';
import { createHealthServer } from './server.js';
const config = parseConfig(); const log = pino({ level: config.LOG_LEVEL }); const bot = createBot(config, log);
const server = createHealthServer(bot, config.HEALTHCHECK_PORT); await prisma.$connect(); bot.login(config.DISCORD_TOKEN);
const shutdown = async () => { server.close(); bot.destroy(); await prisma.$disconnect(); process.exit(0); }; process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
