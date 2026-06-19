import * as path from 'path';

const sensitiveNames = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'known_hosts',
  'credentials',
  'credentials.json'
]);

const sensitiveExtensions = new Set(['.pem', '.key', '.p12', '.pfx']);

export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();

  if (sensitiveNames.has(base)) {
    return true;
  }

  if (base.startsWith('.env.')) {
    return true;
  }

  if (base.startsWith('secrets.')) {
    return true;
  }

  if (sensitiveExtensions.has(path.posix.extname(base))) {
    return true;
  }

  return normalized
    .split('/')
    .some((part) => ['.ssh', '.aws', '.azure', '.gnupg'].includes(part.toLowerCase()));
}

export function shouldSendFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);

  if (isSensitiveFile(filePath)) {
    return false;
  }

  if (base.startsWith('.') && base !== '.parleyignore') {
    return false;
  }

  return true;
}
