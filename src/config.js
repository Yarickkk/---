/** Автор: Кравченко Ярослав Валентинович. Налаштування відокремлено від логіки. */
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(path.join(ROOT, '.env'))) loadEnvFile(path.join(ROOT, '.env'));

export function configuration(overrides = {}) {
  const port = Number(process.env.PORT || 3000);
  const config = {
    port, host: process.env.HOST || '127.0.0.1',
    baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
    database: path.join(ROOT, 'data', 'hotel.sqlite'),
    publicDir: path.join(ROOT, 'public'),
    dataDir: path.join(ROOT, 'data'),
    paymentMode: process.env.PAYMENT_MODE || 'demo',
    publicKey: process.env.LIQPAY_PUBLIC_KEY || '',
    privateKey: process.env.LIQPAY_PRIVATE_KEY || '',
    apiVersion: Number(process.env.LIQPAY_VERSION || 7),
    signatureAlgorithm: process.env.LIQPAY_SIGNATURE_ALGORITHM || 'sha3-256',
    secureCookie: process.env.COOKIE_SECURE === 'true',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@hotel.local',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    mailKey: process.env.RESEND_API_KEY || '', mailFrom: process.env.MAIL_FROM || '',
    now: () => Date.now(), seed: true, ...overrides,
  };
  if (!['demo', 'liqpay'].includes(config.paymentMode)) throw Error('Невідомий PAYMENT_MODE.');
  if (config.paymentMode === 'liqpay') {
    if (!config.publicKey.startsWith('sandbox_') || !config.privateKey.startsWith('sandbox_')) {
      throw Error('Курсовий проєкт приймає лише тестові ключі LiqPay sandbox_.');
    }
    if (!config.baseUrl.startsWith('https://')) throw Error('Для LiqPay потрібен публічний HTTPS BASE_URL.');
    if (config.apiVersion !== 7 || config.signatureAlgorithm !== 'sha3-256') {
      throw Error('Цей адаптер реалізує LiqPay API 7 / SHA3-256.');
    }
    config.secureCookie = true;
  }
  return config;
}
