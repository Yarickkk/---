/** Бізнес-правила готелю. Автор: Кравченко Ярослав Валентинович. */
import { randomUUID } from 'node:crypto';
import { transaction } from './database.js';
import { requireThat, cleanText, phoneNumber, emailAddress, integer, cents, stayDates, today, nights } from './security.js';

export const POLICY = 'Повна передоплата. Безкоштовне скасування до дня заїзду: адміністратор погоджує запит і повертає всю суму. З дня заїзду скасування через систему недоступне. Неоплачений резерв діє 15 хвилин. Повернення зараховується після підтвердження платіжного сервісу.';
export const CATEGORIES = { standard: 'Стандарт', deluxe: 'Делюкс', suite: 'Люкс', family: 'Сімейний' };
const JOIN = `SELECT b.*, r.number room_number, r.title room_title, r.image room_image, u.name user_name,
 u.email user_email FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN users u ON u.id=b.user_id`;

export class Hotel {
  constructor(db, config) { this.db = db; this.config = config; }
  audit(userId, action, detail) {
    this.db.prepare('INSERT INTO audit_log(user_id,action,detail,created_at) VALUES(?,?,?,?)')
      .run(userId || null, action, detail, this.config.now());
  }
  notify(booking, message, mail = true) {
    const insert = this.db.prepare('INSERT INTO notifications(user_id,booking_id,message,created_at) VALUES(?,?,?,?)');
    insert.run(booking.user_id, booking.id, message, this.config.now());
    for (const admin of this.db.prepare("SELECT id FROM users WHERE role='admin' AND id<>?").all(booking.user_id)) {
      insert.run(admin.id, booking.id, message, this.config.now());
    }
    if (mail) this.db.prepare('INSERT INTO mail_outbox(recipient,subject,body,created_at) VALUES(?,?,?,?)')
      .run(booking.contact_email, `Готель Тиша · бронювання ${booking.id.slice(0, 8)}`,
        `${message}\nДати: ${booking.check_in} — ${booking.check_out}\nСума: ${(booking.total / 100).toFixed(2)} грн\n${this.config.baseUrl}/#/booking/${booking.id}`, this.config.now());
  }
  expire() {
    // Прострочені резерви звільняються також перед пошуком і бронюванням,
    // тому правильність не залежить від того, чи спрацював фоновий таймер.
    this.db.prepare("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?").run(this.config.now());
  }
  occupied(roomId, start, end) {
    // Напіввідкритий інтервал [заїзд, виїзд): виїзд і наступний заїзд в один день дозволені.
    return this.db.prepare(`SELECT id FROM bookings WHERE room_id=? AND check_in<? AND check_out>?
      AND (status IN ('confirmed','checked_in') OR (status='pending' AND expires_at>?)) LIMIT 1`)
      .get(roomId, end, start, this.config.now());
  }
  rooms(filters = {}, admin = false) {
    this.expire();
    if (filters.start || filters.end) stayDates(filters.start, filters.end, this.config.now());
    const guests = filters.guests ? integer(filters.guests, 1, 8, 'Кількість гостей') : 1;
    const max = filters.maxPrice ? cents(filters.maxPrice) : Number.MAX_SAFE_INTEGER;
    return this.db.prepare(`SELECT * FROM rooms ${admin ? '' : 'WHERE active=1'} ORDER BY price,id`).all()
      .filter(r => (admin || r.capacity >= guests) && (!filters.category || r.category === filters.category) && r.price <= max)
      .filter(r => !filters.start || !this.occupied(r.id, filters.start, filters.end));
  }
  book(user, data) {
    const { start, end } = stayDates(data.start, data.end, this.config.now());
    const guests = integer(data.guests, 1, 8, 'Кількість гостей');
    requireThat(data.acceptPolicy === true, 'Підтвердьте умови бронювання та скасування.');
    const name = cleanText(data.name, 'Ім’я та прізвище', 2, 100);
    const email = emailAddress(data.email), phone = phoneNumber(data.phone);
    const roomId = integer(data.roomId, 1, 1000000, 'Номер');
    return transaction(this.db, () => {
      this.expire();
      const room = this.db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(roomId);
      requireThat(room, 'Номер недоступний для бронювання.', 404);
      requireThat(guests <= room.capacity, 'Кількість гостей перевищує місткість номера.');
      requireThat(!this.occupied(room.id, start, end), 'Номер щойно забронювали. Оберіть інші дати або номер.', 409);
      requireThat(this.db.prepare("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='pending'").get(user.id).n < 5,
        'Одночасно можна мати не більше 5 неоплачених резервів.');
      const id = randomUUID(), now = this.config.now();
      this.db.prepare(`INSERT INTO bookings(id,user_id,room_id,check_in,check_out,guests,contact_name,contact_email,
        contact_phone,nightly_price,total,policy,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, user.id, room.id, start, end, guests, name, email, phone, room.price, room.price * nights(start, end), POLICY, now, now + 15 * 60 * 1000);
      const booking = this.getBooking(id, user);
      this.notify(booking, `Створено бронювання №${id.slice(0, 8)}. Завершіть оплату протягом 15 хвилин.`);
      this.audit(user.id, 'booking_created', id);
      return booking;
    });
  }
  getBooking(id, user) {
    const booking = this.db.prepare(`${JOIN} WHERE b.id=?`).get(id);
    requireThat(booking && (booking.user_id === user.id || user.role === 'admin'), 'Бронювання не знайдено.', 404);
    booking.payments = this.db.prepare('SELECT * FROM payments WHERE booking_id=? ORDER BY created_at DESC,id').all(id);
    return booking;
  }
  bookings(user, filters = {}) {
    this.expire();
    const rows = user.role === 'admin' ? this.db.prepare(`${JOIN} ORDER BY b.created_at DESC`).all()
      : this.db.prepare(`${JOIN} WHERE b.user_id=? ORDER BY b.created_at DESC`).all(user.id);
    const search = String(filters.search || '').toLowerCase();
    return rows.filter(b => !filters.status || b.status === filters.status)
      .filter(b => !search || [b.id, b.contact_name, b.contact_email, b.room_number].some(v => v.toLowerCase().includes(search)))
      .map(b => ({ ...b, payments: this.db.prepare('SELECT * FROM payments WHERE booking_id=? ORDER BY created_at DESC').all(b.id) }));
  }
  requestCancellation(id, user, reason) {
    return transaction(this.db, () => {
      this.expire();
      const b = this.getBooking(id, user);
      requireThat(['pending', 'confirmed'].includes(b.status), 'Це бронювання вже не можна скасувати.', 409);
      if (b.status === 'confirmed') requireThat(today(this.config.now()) < b.check_in, 'Скасування доступне лише до дня заїзду.');
      requireThat(!b.cancel_requested, 'Запит уже надіслано.', 409);
      const note = cleanText(reason || 'Зміна планів', 'Причина', 2, 500);
      if (b.status === 'pending') {
        this.db.prepare("UPDATE bookings SET status='cancelled',cancel_reason=? WHERE id=?").run(note, id);
        this.notify(b, 'Неоплачене бронювання скасовано.');
      } else {
        this.db.prepare('UPDATE bookings SET cancel_requested=1,cancel_reason=? WHERE id=?').run(note, id);
        this.notify(b, 'Запит на скасування надіслано адміністратору. Номер залишається заброньованим до погодження.');
      }
      this.audit(user.id, 'cancellation_requested', id);
      return this.getBooking(id, user);
    });
  }
  adminAction(id, user, action) {
    return transaction(this.db, () => {
      this.expire();
      const b = this.getBooking(id, user);
      if (action === 'approve_cancel') {
        requireThat(b.cancel_requested && b.status === 'confirmed', 'Немає запиту на скасування.', 409);
        // Умови перевірені на момент подання: затримка адміністратора не позбавляє клієнта повернення.
        this.db.prepare("UPDATE bookings SET status='cancelled',cancel_requested=0 WHERE id=?").run(id);
        this.db.prepare("UPDATE payments SET status='refund_required' WHERE booking_id=? AND status='paid'").run(id);
        this.notify(b, 'Скасування погоджено. Повернення коштів очікує виконання.');
      } else if (action === 'reject_cancel') {
        requireThat(b.cancel_requested, 'Немає запиту на скасування.', 409);
        this.db.prepare('UPDATE bookings SET cancel_requested=0 WHERE id=?').run(id);
        this.notify(b, 'Адміністратор відхилив запит на скасування. Зверніться до готелю для уточнення.');
      } else if (action === 'check_in') {
        requireThat(b.status === 'confirmed' && !b.cancel_requested, 'Потрібне підтверджене бронювання без запиту на скасування.', 409);
        const date = today(this.config.now());
        requireThat(date >= b.check_in && date < b.check_out, 'Заселення можливе лише в межах періоду проживання.');
        this.db.prepare("UPDATE bookings SET status='checked_in' WHERE id=?").run(id);
        this.notify(b, 'Заселення зареєстровано. Приємного відпочинку!');
      } else if (action === 'check_out') {
        requireThat(b.status === 'checked_in', 'Клієнт ще не заселився.', 409);
        // Дострокова зміна дат і перерахунок тарифу не входять до цієї версії.
        // Так календар, оплачений період і звіт залишаються узгодженими.
        requireThat(today(this.config.now()) >= b.check_out, 'Завершити проживання можна з дати запланованого виїзду.');
        this.db.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(id);
        this.notify(b, 'Проживання завершено. Дякуємо, що обрали наш готель!');
      } else requireThat(false, 'Невідома дія.');
      this.audit(user.id, action, id);
      return this.getBooking(id, user);
    });
  }
  saveRoom(id, data, user) {
    const number = cleanText(data.number, 'Позначення номера', 1, 10);
    const title = cleanText(data.title, 'Назва', 3, 80);
    requireThat(Object.hasOwn(CATEGORIES, data.category), 'Оберіть категорію.');
    const capacity = integer(data.capacity, 1, 8, 'Місткість');
    const area = integer(data.area, 10, 300, 'Площа');
    const price = cents(data.price);
    requireThat(price >= 10000 && price <= 10000000, 'Ціна за ніч: від 100 до 100 000 грн.');
    const description = cleanText(data.description, 'Опис', 10, 2000);
    const amenities = cleanText(data.amenities, 'Зручності', 2, 300);
    const image = cleanText(data.image, 'Зображення', 1, 200);
    requireThat(/^\/(images\/(standard|garden|deluxe|family|suite)\.svg|uploads\/[a-f0-9-]+\.(png|jpg))$/.test(image), 'Оберіть або завантажте зображення.');
    return transaction(this.db, () => {
      const duplicate = this.db.prepare('SELECT id FROM rooms WHERE number=? AND id<>?').get(number, id || 0);
      requireThat(!duplicate, 'Таке позначення номера вже існує.', 409);
      if (id) {
        requireThat(this.db.prepare('SELECT id FROM rooms WHERE id=?').get(id), 'Номер не знайдено.', 404);
        const existing = this.db.prepare("SELECT MAX(guests) n FROM bookings WHERE room_id=? AND status IN ('pending','confirmed','checked_in') AND check_out>?").get(id, today(this.config.now()));
        requireThat(!existing.n || capacity >= existing.n, 'Місткість менша за кількість гостей в активному бронюванні.');
        this.db.prepare('UPDATE rooms SET number=?,title=?,category=?,capacity=?,area=?,price=?,description=?,amenities=?,image=?,active=? WHERE id=?')
          .run(number, title, data.category, capacity, area, price, description, amenities, image, data.active ? 1 : 0, id);
      } else {
        id = Number(this.db.prepare('INSERT INTO rooms(number,title,category,capacity,area,price,description,amenities,image,active) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(number, title, data.category, capacity, area, price, description, amenities, image, data.active ? 1 : 0).lastInsertRowid);
      }
      this.audit(user.id, 'room_saved', String(id));
      return this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    });
  }
  report(start, end) {
    stayDates(start, end, this.config.now(), false, 366);
    const period = timestamp => timestamp && today(timestamp) >= start && today(timestamp) < end;
    const payments = this.db.prepare('SELECT * FROM payments').all();
    const received = payments.filter(p => period(p.paid_at)).reduce((s, p) => s + p.amount, 0);
    const refunded = payments.filter(p => period(p.refunded_at)).reduce((s, p) => s + p.amount, 0);
    const rows = this.db.prepare('SELECT * FROM bookings WHERE check_in<? AND check_out>?').all(end, start);
    const reservedNights = rows.filter(b => ['confirmed','checked_in','completed'].includes(b.status))
      .reduce((sum, b) => sum + nights(b.check_in > start ? b.check_in : start, b.check_out < end ? b.check_out : end), 0);
    const capacityNights = this.db.prepare('SELECT COUNT(*) n FROM rooms').get().n * nights(start, end);
    return { start, end, received, refunded, net: received - refunded, bookings: rows.length,
      confirmed: rows.filter(b => ['confirmed','checked_in','completed'].includes(b.status)).length,
      cancelled: rows.filter(b => ['cancelled','expired'].includes(b.status)).length,
      reservedNights, capacityNights, occupancy: capacityNights ? Math.round(reservedNights / capacityNights * 1000) / 10 : 0 };
  }
}
