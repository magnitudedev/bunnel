import pino from 'pino';

export const logger = pino({
    level: process.env.BUNNEL_LOG_LEVEL || 'info'
});

export default logger;
