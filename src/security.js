import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireThat(condition, message, status = 400) {
  if (!condition) throw new AppError(message, status);
}
// Сіль для кожного пароля різна: однакові паролі не мають однакових хешів.
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
export function cleanText(value, label, min = 1, max = 100) {
  requireThat(typeof value === 'string', `Заповніть поле «${label}».`);
  const text = value.trim();
  requireThat(text.length >= min && text.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text),
    `Поле «${label}»: від ${min} до ${max} символів.`);
  return text;
}
export function emailAddress(value) {
  const email = cleanText(value, 'Електронна пошта', 5, 254).toLowerCase();
  requireThat(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Некоректна електронна пошта.');
  return email;
}
export function phoneNumber(value) {
  const phone = cleanText(value, 'Телефон', 7, 25);
  requireThat(/^\+?[\d\s()\-]{7,25}$/.test(phone) && phone.replace(/\D/g, '').length >= 7, 'Некоректний телефон.');
  return phone;
}
export function integer(value, min, max, label) {
  requireThat(value !== '' && value !== null && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max,
    `${label}: ціле число від ${min} до ${max}.`);
  return Number(value);
}
// Грошові суми зберігаються в копійках, щоб уникнути похибок 0.1 + 0.2.
export function cents(value) {
  const text = String(value);
  requireThat(/^\d{1,8}(\.\d{1,2})?$/.test(text), 'Некоректна сума.');
  return Math.round(Number(text) * 100);
}
export function dateString(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Дата має формат РРРР-ММ-ДД.');
  const date = new Date(value + 'T00:00:00Z');
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'Неіснуюча дата.');
  return value;
}
export function today(now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export const nights = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000;
export function stayDates(start, end, now, future = true, maximum = 90) {
  dateString(start); dateString(end);
  requireThat(end > start && nights(start, end) <= maximum, `Оберіть період від 1 до ${maximum} ночей.`);
  if (future) requireThat(start >= today(now), 'Дата заїзду не може бути в минулому.');
  return { start, end };
}
