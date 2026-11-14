import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { requireThat, cents } from './security.js';

// LiqPay API 7: base64(SHA3-256(private_key + data + private_key)).
// Джерело: https://www.liqpay.ua/doc/api/callback
export function sign(data, privateKey) {
  return createHash('sha3-256').update(privateKey + data + privateKey).digest('base64');
}
export function pack(payload, config) {
  const data = Buffer.from(JSON.stringify({ version: config.apiVersion, public_key: config.publicKey, ...payload })).toString('base64');
  return { data, signature: sign(data, config.privateKey) };
}
export function verifyCallback(data, signature, config) {
  requireThat(typeof data === 'string' && typeof signature === 'string', 'Некоректне повідомлення.', 400);
  const expected = Buffer.from(sign(data, config.privateKey));
  const supplied = Buffer.from(signature);
  requireThat(expected.length === supplied.length && timingSafeEqual(expected, supplied), 'Недійсний підпис.', 403);
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch { requireThat(false, 'Некоректний JSON.'); }
  requireThat(payload.public_key === config.publicKey && String(payload.version) === String(config.apiVersion), 'Невідомий магазин або версія API.', 400);
  return payload;
}
export class Payments {
  constructor(hotel) { this.hotel = hotel; this.db = hotel.db; this.config = hotel.config; }
  create(bookingId, user) {
    const payment = transaction(this.db, () => {
      this.hotel.expire();
      const b = this.hotel.getBooking(bookingId, user);
      requireThat(b.user_id === user.id, 'Оплачувати бронювання може його власник.', 403);
      requireThat(b.status === 'pending', 'Це бронювання вже не очікує оплати.', 409);
      const existing = this.db.prepare("SELECT * FROM payments WHERE booking_id=? AND status='pending'").get(bookingId);
      if (existing) return existing;
      const id = randomUUID();
      this.db.prepare('INSERT INTO payments(id,booking_id,provider,amount,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, bookingId, this.config.paymentMode, b.total, 'pending', this.config.now());
      return this.db.prepare('SELECT * FROM payments WHERE id=?').get(id);
    });
    if (payment.provider === 'demo') return { payment, mode: 'demo' };
    const payload = pack({ action: 'pay', amount: (payment.amount / 100).toFixed(2), currency: 'UAH',
      description: `Проживання · ${bookingId.slice(0, 8)}`, order_id: payment.id, language: 'uk',
      server_url: `${this.config.baseUrl}/api/payments/liqpay/callback`,
      result_url: `${this.config.baseUrl}/#/booking/${bookingId}` }, this.config);
    return { payment, mode: 'liqpay', url: 'https://www.liqpay.ua/api/3/checkout', ...payload };
  }
  apply(payload, provider) {
    // Callback не довіряє сумі з браузера. Порівнюємо її зі знімком ціни в БД.
    return transaction(this.db, () => {
      this.hotel.expire();
      const p = this.db.prepare('SELECT * FROM payments WHERE id=? AND provider=?').get(String(payload.order_id || ''), provider);
      requireThat(p, 'Платіж не знайдено.', 404);
      requireThat(payload.currency === 'UAH' && cents(payload.amount) === p.amount, 'Сума або валюта не відповідає бронюванню.', 400);
      const providerId = String(payload.payment_id || '');
      requireThat(providerId.length > 0 && providerId.length <= 150, 'Відсутній ідентифікатор транзакції.');
      const eventId = `${provider}:${providerId}:${payload.status}`;
      if (this.db.prepare('SELECT id FROM payment_events WHERE id=?').get(eventId)) return { duplicate: true };
      if (p.provider_id) requireThat(p.provider_id === `${provider}:${providerId}`, 'Ідентифікатор платежу змінився.', 409);
      const collision = this.db.prepare('SELECT id FROM payments WHERE provider_id=? AND id<>?').get(`${provider}:${providerId}`, p.id);
      requireThat(!collision, 'Транзакція вже прив’язана до іншого платежу.', 409);
      const b = this.db.prepare('SELECT * FROM bookings WHERE id=?').get(p.booking_id);
      const success = ['success', 'sandbox'].includes(payload.status);
      if (success && ['pending', 'failed'].includes(p.status)) {
        const refundable = b.status !== 'pending' || b.expires_at <= this.config.now();
        this.db.prepare('UPDATE payments SET status=?,provider_id=?,paid_at=? WHERE id=?')
          .run(refundable ? 'refund_required' : 'paid', `${provider}:${providerId}`, this.config.now(), p.id);
        if (!refundable) {
          this.db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(b.id);
          this.hotel.notify(b, 'Оплату отримано. Бронювання підтверджено.');
        } else this.hotel.notify(b, 'Отримано оплату для неактивного або вже оплаченого бронювання. Потрібне повернення коштів; бронювання не змінено.');
      } else if (['failure','error'].includes(payload.status) && p.status === 'pending') {
        this.db.prepare("UPDATE payments SET status='failed',provider_id=? WHERE id=?").run(`${provider}:${providerId}`, p.id);
        this.hotel.notify(b, 'Оплату не виконано. Можна повторити спробу до завершення резервування.');
      } else if (payload.status === 'reversed' && ['paid','refund_required','refund_pending'].includes(p.status)) {
        // Для цієї курсової реалізовано лише повне повернення.
        this.db.prepare("UPDATE payments SET status='refunded',refunded_at=?,refund_error='' WHERE id=?").run(this.config.now(), p.id);
        // Повернення зайвої, запізнілої оплати не скасовує бронювання,
        // яке вже підтверджене іншим успішним платежем.
        const hasOtherPayment = this.db.prepare("SELECT id FROM payments WHERE booking_id=? AND id<>? AND status='paid'").get(b.id, p.id);
        if (!hasOtherPayment && ['pending','confirmed'].includes(b.status)) this.db.prepare("UPDATE bookings SET status='cancelled',cancel_requested=0 WHERE id=?").run(b.id);
        this.hotel.notify(b, 'Повне повернення коштів підтверджено.');
      }
      this.db.prepare('INSERT INTO payment_events(id,payment_id,status,created_at) VALUES(?,?,?,?)').run(eventId, p.id, String(payload.status), this.config.now());
      this.hotel.audit(null, 'payment_event', `${p.id}: ${payload.status}`);
      return { accepted: true };
    });
  }
  simulate(id, outcome, user) {
    requireThat(this.config.paymentMode === 'demo', 'Демонстраційна оплата вимкнена.', 404);
    requireThat(['success','failure'].includes(outcome), 'Оберіть результат оплати.');
    const p = this.db.prepare("SELECT * FROM payments WHERE id=? AND provider='demo'").get(id);
    requireThat(p, 'Платіж не знайдено.', 404);
    const b = this.hotel.getBooking(p.booking_id, user);
    requireThat(b.user_id === user.id, 'Доступ заборонено.', 403);
    return this.apply({ order_id: id, payment_id: id, status: outcome, amount: (p.amount / 100).toFixed(2), currency: 'UAH' }, 'demo');
  }
  async requestApi(payload) {
    let response;
    try {
      response = await fetch('https://www.liqpay.ua/api/request', {
        method: 'POST', body: new URLSearchParams(pack(payload, this.config)), signal: AbortSignal.timeout(15000),
      });
      requireThat(response.ok, 'Платіжний сервіс тимчасово недоступний.', 502);
      return await response.json();
    } catch (error) {
      if (error.status) throw error;
      requireThat(false, 'Не вдалося отримати відповідь платіжного сервісу. Перевірте стан платежу.', 502);
    }
  }
  async refund(id, user) {
    const p = transaction(this.db, () => {
      const record = this.db.prepare('SELECT * FROM payments WHERE id=?').get(id);
      requireThat(record, 'Платіж не знайдено.', 404);
      requireThat(record.status === 'refund_required', 'Повернення вже виконано, виконується або не потрібне.', 409);
      this.db.prepare("UPDATE payments SET status='refund_pending',refund_error='' WHERE id=?").run(id);
      this.hotel.audit(user.id, 'refund_requested', id);
      return record;
    });
    if (p.provider === 'demo') return this.apply({ order_id: p.id, payment_id: p.id, status: 'reversed',
      currency: 'UAH', amount: (p.amount / 100).toFixed(2) }, 'demo');
    try {
      const result = await this.requestApi({ action: 'refund', order_id: p.id, amount: (p.amount / 100).toFixed(2) });
      if (result.status === 'error' || result.result === 'error') {
        // Явна відмова дозволяє повтор. При мережевій невизначеності залишаємо pending.
        this.db.prepare("UPDATE payments SET status='refund_required',refund_error=? WHERE id=? AND status='refund_pending'")
          .run(String(result.err_description || 'Сервіс відхилив повернення.').slice(0, 500), p.id);
        requireThat(false, 'LiqPay відхилив повернення. Перегляньте помилку в платежі.', 502);
      }
      return { pending: true };
    } catch (error) {
      this.db.prepare('UPDATE payments SET refund_error=? WHERE id=?').run(error.message.slice(0, 500), p.id);
      throw error;
    }
  }
  async sync(id, user) {
    const p = this.db.prepare("SELECT * FROM payments WHERE id=? AND provider='liqpay'").get(id);
    requireThat(p, 'Платіж LiqPay не знайдено.', 404);
    this.hotel.getBooking(p.booking_id, user);
    const result = await this.requestApi({ action: 'status', order_id: p.id });
    // Відповідь отримана безпосередньо з HTTPS API, а не з браузерного redirect.
    requireThat(result.order_id === p.id, 'Сервіс повернув інше замовлення.', 502);
    return this.apply(result, 'liqpay');
  }
}
