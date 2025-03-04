import pino from 'pino';

export const logger = pino({
    level: process.env.BUNNEL_LOG_LEVEL || 'info'
}).child({
    name: "tunnel.server"
});

export default logger;
