-- Автор: Кравченко Ярослав Валентинович.
-- Зовнішні ключі пов'язують користувача, конкретний номер, бронювання й платежі.
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 phone TEXT NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('client','admin')), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
 id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('standard','deluxe','suite','family')),
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 8), area INTEGER NOT NULL,
 price INTEGER NOT NULL CHECK(price > 0), description TEXT NOT NULL, amenities TEXT NOT NULL,
 image TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS bookings (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), room_id INTEGER NOT NULL REFERENCES rooms(id),
 check_in TEXT NOT NULL, check_out TEXT NOT NULL CHECK(check_out > check_in), guests INTEGER NOT NULL CHECK(guests > 0),
 contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, contact_phone TEXT NOT NULL,
 nightly_price INTEGER NOT NULL CHECK(nightly_price > 0), total INTEGER NOT NULL CHECK(total > 0),
 policy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','confirmed','checked_in','completed','cancelled','expired')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 cancel_requested INTEGER NOT NULL DEFAULT 0, cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS booking_dates ON bookings(room_id,check_in,check_out,status);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id),
 provider TEXT NOT NULL CHECK(provider IN ('demo','liqpay')), amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'UAH',
 status TEXT NOT NULL CHECK(status IN ('pending','failed','paid','refund_required','refund_pending','refunded')),
 provider_id TEXT UNIQUE, created_at INTEGER NOT NULL, paid_at INTEGER, refunded_at INTEGER,
 refund_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS payment_booking ON payments(booking_id);
CREATE TABLE IF NOT EXISTS payment_events (
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id), status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), booking_id TEXT REFERENCES bookings(id),
 message TEXT NOT NULL, created_at INTEGER NOT NULL, is_read INTEGER NOT NULL DEFAULT 0
);
-- Черга листів зберігається разом із бізнес-операцією: збій пошти не втрачає бронювання.
CREATE TABLE IF NOT EXISTS mail_outbox (
 id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 created_at INTEGER NOT NULL, sent_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
