import crypto from 'node:crypto';

/**
 * Hash an API key using SHA-256.
 * @param {string} key - Raw API key
 * @returns {string} - Hex-encoded hash
 */
export function hashKey(key) {
  if (!key) return '';
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Mask an API key for display purposes (e.g., bc_abcdef...wxyz).
 * @param {string} key - Raw API key
 * @param {number} prefixLen - Number of characters to keep at the start (default: 6)
 * @param {number} suffixLen - Number of characters to keep at the end (default: 4)
 * @returns {string} - Masked API key
 */
export function maskKey(key, prefixLen = 6, suffixLen = 4) {
  if (!key) return '';
  if (key.length <= prefixLen + suffixLen) return key;
  return key.substring(0, prefixLen) + '...' + key.substring(key.length - suffixLen);
}
