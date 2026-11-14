/** HTTP API та запуск сервера. Автор: Кравченко Ярослав Валентинович. */
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configuration } from './config.js';
import { openDatabase, transaction } from './database.js';
import { Hotel, POLICY, CATEGORIES } from './hotel.js';
import { Payments, verifyCallback } from './payments.js';
import { token, digest, hashPassword, verifyPassword, requireThat, AppError, cleanText, emailAddress, phoneNumber, integer, today, stayDates } from './security.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const publicUser = user => user ? { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } : null;
async function readBody(req, max = 3 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; requireThat(size <= max, 'Завеликий запит.', 413); chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  requireThat(String(req.headers['content-type']).startsWith('application/json'), 'Потрібен формат JSON.', 415);
  try {
    const parsed = JSON.parse(raw || '{}');
    requireThat(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Потрібен JSON-об’єкт.');
    return parsed;
  } catch { throw new AppError('Некоректний JSON.'); }
}

export function createApp(overrides = {}) {
  const config = configuration(overrides), db = openDatabase(config);
  const hotel = new Hotel(db, config), payments = new Payments(hotel);
  const attempts = new Map();
  const dummyHash = hashPassword('not-a-real-account-password');
  function session(req, res) {
    const cookie = /(?:^|;\s*)hotel_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    let row = cookie && db.prepare('SELECT * FROM sessions WHERE id_hash=? AND expires_at>?').get(digest(cookie), config.now());
    if (!row) {
      const id = token();
      row = { id_hash: digest(id), user_id: null, csrf: token(), expires_at: config.now() + 86400000 };
      db.prepare('INSERT INTO sessions(id_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(row.id_hash, null, row.csrf, row.expires_at);
      setCookie(res, id);
    }
    return { ...row, user: row.user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(row.user_id) : null };
  }
  function setCookie(res, id) {
    res.setHeader('Set-Cookie', `hotel_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${config.secureCookie ? '; Secure' : ''}`);
  }
  function loginSession(old, userId, res) {
    // Після входу ідентифікатор сесії змінюється, щоб не допустити session fixation.
    const id = token(), csrf = token();
    transaction(db, () => {
      db.prepare('DELETE FROM sessions WHERE id_hash=?').run(old.id_hash);
      db.prepare('INSERT INTO sessions(id_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(digest(id), userId, csrf, config.now() + 86400000);
    });
    setCookie(res, id); return csrf;
  }
  function authLimit(req) {
    const ip = req.socket.remoteAddress || 'local', now = config.now();
    let entry = attempts.get(ip);
    if (!entry || entry.until < now) { entry = { count: 0, until: now + 600000 }; attempts.set(ip, entry); }
    requireThat(++entry.count <= 30, 'Забагато спроб. Спробуйте через 10 хвилин.', 429);
  }
  const server = http.createServer(async (req, res) => {
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://www.liqpay.ua; frame-ancestors 'none'; base-uri 'none'");
    if (config.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, 'http://local'), route = url.pathname, method = req.method;
      if (!route.startsWith('/api/')) {
        requireThat(method === 'GET' || method === 'HEAD', 'Метод не підтримується.', 405);
        let file;
        if (route === '/') file = path.join(config.publicDir, 'index.html');
        else if (/^\/uploads\/[a-f0-9-]+\.(jpg|png)$/.test(route)) file = path.join(config.dataDir, route.slice(1));
        else if (/^\/(app\.js|styles\.css|images\/[a-z-]+\.svg)$/.test(route)) file = path.join(config.publicDir, route.slice(1));
        requireThat(file && existsSync(file), 'Сторінку не знайдено.', 404);
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(method === 'HEAD' ? undefined : readFileSync(file)); return;
      }
      res.setHeader('Cache-Control', 'no-store');
      // Webhook не має браузерної сесії: його захищає криптографічний підпис.
      if (route === '/api/payments/liqpay/callback' && method === 'POST') {
        requireThat(config.paymentMode === 'liqpay', 'Платіжний сервіс не підключено.', 404);
        const body = await readBody(req, 64000);
        return json(payments.apply(verifyCallback(body.data, body.signature, config), 'liqpay'));
      }
      const current = session(req, res);
      let body = {};
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = req.headers.origin;
        const localPort = server.address()?.port;
        const permitted = [config.baseUrl, `http://localhost:${localPort}`, `http://127.0.0.1:${localPort}`];
        requireThat(!origin || permitted.includes(origin), 'Чужий сайт не може виконувати цю дію.', 403);
        requireThat(req.headers['x-csrf-token'] === current.csrf, 'Оновіть сторінку та повторіть дію.', 403);
        body = await readBody(req);
      }
      if (route === '/api/me' && method === 'GET') return json({ user: publicUser(current.user), csrf: current.csrf,
        today: today(config.now()), now: config.now(), paymentMode: config.paymentMode, policy: POLICY, categories: CATEGORIES,
        mailEnabled: Boolean(config.mailKey && config.mailFrom) });
      if (route === '/api/register' && method === 'POST') {
        authLimit(req);
        const name = cleanText(body.name, 'Ім’я та прізвище', 2, 100), email = emailAddress(body.email), phone = phoneNumber(body.phone);
        const password = cleanText(body.password, 'Пароль', 10, 128);
        requireThat(!db.prepare('SELECT id FROM users WHERE email=?').get(email), 'Ця пошта вже зареєстрована.', 409);
        const id = Number(db.prepare('INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
          .run(name, email, phone, hashPassword(password), 'client', config.now()).lastInsertRowid);
        const csrf = loginSession(current, id, res);
        return json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)), csrf }, 201);
      }
      if (route === '/api/login' && method === 'POST') {
        authLimit(req);
        const email = emailAddress(body.email), password = cleanText(body.password, 'Пароль', 1, 128);
        const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const correct = verifyPassword(password, user?.password_hash || dummyHash);
        requireThat(user && correct, 'Неправильна пошта або пароль.', 401);
        return json({ user: publicUser(user), csrf: loginSession(current, user.id, res) });
      }
      if (route === '/api/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE id_hash=?').run(current.id_hash);
        res.setHeader('Set-Cookie', `hotel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookie ? '; Secure' : ''}`);
        return json({ ok: true });
      }
      if (route === '/api/rooms' && method === 'GET') return json(hotel.rooms(Object.fromEntries(url.searchParams)));
      requireThat(current.user, 'Увійдіть до особистого кабінету.', 401);
      const user = current.user;
      if (route === '/api/bookings' && method === 'GET') return json(hotel.bookings(user));
      if (route === '/api/bookings' && method === 'POST') return json(hotel.book(user, body), 201);
      let match;
      if ((match = /^\/api\/bookings\/([a-f0-9-]+)$/.exec(route)) && method === 'GET') {
        hotel.expire(); return json(hotel.getBooking(match[1], user));
      }
      if ((match = /^\/api\/bookings\/([a-f0-9-]+)\/cancel$/.exec(route)) && method === 'POST') return json(hotel.requestCancellation(match[1], user, body.reason));
      if ((match = /^\/api\/bookings\/([a-f0-9-]+)\/checkout$/.exec(route)) && method === 'POST') return json(payments.create(match[1], user));
      if ((match = /^\/api\/payments\/([a-f0-9-]+)\/simulate$/.exec(route)) && method === 'POST') return json(payments.simulate(match[1], body.outcome, user));
      if ((match = /^\/api\/payments\/([a-f0-9-]+)\/sync$/.exec(route)) && method === 'POST') return json(await payments.sync(match[1], user));
      if (route === '/api/notifications' && method === 'GET') return json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(user.id));
      if (route === '/api/notifications/read' && method === 'POST') {
        db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(user.id); return json({ ok: true });
      }
      requireThat(route.startsWith('/api/admin/'), 'Маршрут не знайдено.', 404);
      requireThat(user.role === 'admin', 'Доступ лише для адміністратора.', 403);
      if (route === '/api/admin/bookings' && method === 'GET') return json(hotel.bookings(user, Object.fromEntries(url.searchParams)));
      if (route === '/api/admin/rooms' && method === 'GET') return json(hotel.rooms({}, true));
      if (route === '/api/admin/rooms' && method === 'POST') return json(hotel.saveRoom(null, body, user), 201);
      if ((match = /^\/api\/admin\/rooms\/(\d+)$/.exec(route)) && method === 'PUT') return json(hotel.saveRoom(integer(match[1], 1, 1000000, 'Номер'), body, user));
      if ((match = /^\/api\/admin\/bookings\/([a-f0-9-]+)\/action$/.exec(route)) && method === 'POST') return json(hotel.adminAction(match[1], user, body.action));
      if ((match = /^\/api\/admin\/payments\/([a-f0-9-]+)\/refund$/.exec(route)) && method === 'POST') return json(await payments.refund(match[1], user));
      if (route === '/api/admin/calendar' && method === 'GET') {
        const { start, end } = Object.fromEntries(url.searchParams); stayDates(start, end, config.now(), false, 62); hotel.expire();
        const bookings = db.prepare(`SELECT b.id,b.room_id,b.check_in,b.check_out,b.contact_name,b.status FROM bookings b
          WHERE b.check_in<? AND b.check_out>? AND (b.status IN ('confirmed','checked_in','completed') OR (b.status='pending' AND b.expires_at>?))`).all(end, start, config.now());
        return json({ rooms: hotel.rooms({}, true), bookings, start, end });
      }
      if (['/api/admin/report','/api/admin/report.csv'].includes(route) && method === 'GET') {
        const report = hotel.report(url.searchParams.get('start'), url.searchParams.get('end'));
        if (route.endsWith('.csv')) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');res.setHeader('Content-Disposition', 'attachment; filename="hotel-report.csv"');
          return res.end('\uFEFFПочаток;Кінець (не включно);Бронювання;Підтверджені;Скасовані;Надходження грн;Повернення грн;Різниця грн;Заброньовані ночі;Доступні ночі;Завантаження %\r\n' +
            [report.start,report.end,report.bookings,report.confirmed,report.cancelled,report.received/100,report.refunded/100,report.net/100,report.reservedNights,report.capacityNights,report.occupancy].join(';'));
        }
        return json(report);
      }
      if (route === '/api/admin/mail' && method === 'GET') return json(db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT 100').all());
      if (route === '/api/admin/audit' && method === 'GET') return json(db.prepare('SELECT a.*,u.name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100').all());
      if (route === '/api/admin/upload' && method === 'POST') {
        requireThat(typeof body.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data), 'Некоректний файл.');
        const buffer = Buffer.from(body.data, 'base64');
        requireThat(buffer.length > 8 && buffer.length <= 2 * 1024 * 1024, 'Фото має бути до 2 МБ.');
        const png = buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
        requireThat(png || jpeg, 'Дозволено лише PNG або JPEG.');
        const name = `${randomUUID()}.${png ? 'png' : 'jpg'}`;
        mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
        writeFileSync(path.join(config.dataDir, 'uploads', name), buffer);
        return json({ image: `/uploads/${name}` }, 201);
      }
      throw new AppError('Маршрут не знайдено.', 404);
    } catch (error) {
      if (!error.status) console.error('Помилка сервера:', error);
      if (!res.headersSent) json({ error: error.status ? error.message : 'Внутрішня помилка. Спробуйте ще раз.' }, error.status || 500);
      else res.end();
    }
  });
  const timer = setInterval(() => {
    hotel.expire(); db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(config.now());
    for (const [ip, entry] of attempts) if (entry.until < config.now()) attempts.delete(ip);
  }, 30000).unref();
  server.on('close', () => { clearInterval(timer); db.close(); });
  return { server, db, hotel, payments, config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Порт зайнятий. Закрийте попередній сервер або змініть PORT у .env.' : error.message);
    process.exit(1);
  });
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`АІС «Тиша» · http://localhost:${app.config.port}`);
    console.log(`Режим оплати: ${app.config.paymentMode}. Доступ адміністратора: data/admin-access.txt (або ADMIN_PASSWORD з .env).`);
  });
  process.on('SIGINT', () => app.server.close());
  process.on('SIGTERM', () => app.server.close());
}
