import crypto from 'node:crypto';

const LICENSE_SECRET = 'synastry-license-secret-2025';

const DAY_MS = 24 * 60 * 60 * 1000;

function signPayload(payload) {
  return crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('base64url');
}

export function generateLicenseKey(owner, daysValid) {
  if (!owner || typeof owner !== 'string') {
    throw new Error('Owner must be a non-empty string');
  }
  const durationMs = typeof daysValid === 'number' && Number.isFinite(daysValid) && daysValid > 0
    ? Math.round(daysValid) * DAY_MS
    : 365 * DAY_MS;
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  const payloadObj = { o: owner.trim(), e: expiresAt };
  const payloadJson = JSON.stringify(payloadObj);
  const payloadEncoded = Buffer.from(payloadJson, 'utf-8').toString('base64url');
  const signature = signPayload(payloadJson);
  return `${payloadEncoded}.${signature}`;
}

export function verifyLicenseKey(key) {
  if (typeof key !== 'string') {
    return { valid: false, reason: 'Ключ должен быть строкой.' };
  }

  const normalized = key.trim();
  if (!normalized) {
    return { valid: false, reason: 'Ключ не может быть пустым.' };
  }

  const parts = normalized.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'Некорректный формат ключа.' };
  }

  const [payloadEncoded, signatureProvided] = parts;
  let payloadJson;
  try {
    payloadJson = Buffer.from(payloadEncoded, 'base64url').toString('utf-8');
  } catch (error) {
    return { valid: false, reason: 'Не удалось прочитать данные ключа.' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (error) {
    return { valid: false, reason: 'Некорректные данные ключа.' };
  }

  if (typeof payload?.o !== 'string' || typeof payload?.e !== 'string') {
    return { valid: false, reason: 'Отсутствуют данные владельца или срока действия.' };
  }

  let signatureExpected;
  try {
    signatureExpected = signPayload(payloadJson);
  } catch (error) {
    return { valid: false, reason: 'Не удалось проверить подпись ключа.' };
  }

  const providedBuf = Buffer.from(signatureProvided, 'base64url');
  const expectedBuf = Buffer.from(signatureExpected, 'base64url');

  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: 'Подпись ключа не совпадает.' };
  }

  const expiresAt = new Date(payload.e);
  if (Number.isNaN(expiresAt.getTime())) {
    return { valid: false, reason: 'Некорректная дата окончания ключа.' };
  }

  const now = Date.now();
  const expired = expiresAt.getTime() <= now;

  return {
    valid: !expired,
    expired,
    reason: expired ? 'Срок действия ключа истёк.' : undefined,
    owner: payload.o,
    expiresAt: expiresAt.toISOString(),
  };
}
