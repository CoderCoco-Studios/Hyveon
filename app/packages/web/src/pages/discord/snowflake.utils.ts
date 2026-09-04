/**
 * Discord snowflake ID helpers, re-exported from the shared library location
 * (`@/lib/snowflake.utils.js`) so callers in this directory can import them
 * alongside the rest of the Discord page split.
 */
export { isSnowflake, parseSnowflakes } from '../../lib/snowflake.utils.js';
