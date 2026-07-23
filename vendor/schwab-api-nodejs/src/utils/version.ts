import pkg from '../../package.json' with { type: 'json' };

const version = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

export const SDK_VERSION = version;
export const DEFAULT_USER_AGENT = `schwab-owokit/${version} (+https://github.com/schwab-owokit/schwab-api-nodejs)`;
