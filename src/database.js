import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword, token } from './security.js';

export function openDatabase(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(config.database, { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (config.seed) seed(db, config);
  return db;
}
// Перевірка доступності і вставлення бронювання — ОДНА транзакція.
// BEGIN IMMEDIATE не дозволяє двом процесам одночасно забронювати той самий номер.
export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function seed(db, config) {
  if (!db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
    const password = config.adminPassword || `Hotel-${token().slice(0, 16)}!`;
    db.prepare('INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
      .run('Адміністратор готелю', config.adminEmail.toLowerCase(), '+380000000000', hashPassword(password), 'admin', config.now());
    if (!config.adminPassword) writeFileSync(path.join(config.dataDir, 'admin-access.txt'),
      `Вхід адміністратора\nEmail: ${config.adminEmail}\nПароль: ${password}\nЗбережіть ці дані. Файл не включати до публічного репозиторію.\n`, { mode: 0o600 });
  }
  if (db.prepare('SELECT COUNT(*) count FROM rooms').get().count) return;
  const rooms = [
    ['101', 'Тихий стандарт', 'standard', 2, 22, 180000, 'Затишний номер у теплих відтінках для короткої подорожі чи робочої поїздки.', 'Wi-Fi,Кондиціонер,Душ,Робочий стіл', 'standard'],
    ['102', 'Стандарт із видом на сад', 'standard', 2, 24, 195000, 'Світлий простір із великим вікном і зручним двоспальним ліжком.', 'Wi-Fi,Кондиціонер,Душ,Вид на сад', 'garden'],
    ['201', 'Делюкс із балконом', 'deluxe', 2, 32, 270000, 'Більше простору для неспішного відпочинку. Балкон, зона читання та м’яке світло.', 'Wi-Fi,Балкон,Кавомашина,Ванна', 'deluxe'],
    ['202', 'Сімейний простір', 'family', 4, 42, 340000, 'Продуманий номер для родини: двоспальне ліжко, диван і спільна зона відпочинку.', 'Wi-Fi,Диван,Холодильник,Дитяче ліжечко', 'family'],
    ['301', 'Люкс Панорама', 'suite', 2, 50, 420000, 'Вітальня та спальня з панорамним вікном. Простір, у якому приємно залишитися довше.', 'Wi-Fi,Вітальня,Кавомашина,Панорамний вид', 'suite'],
    ['302', 'Люкс для родини', 'suite', 4, 58, 490000, 'Дві окремі зони для відпочинку та спільних вечорів. Комфорт для чотирьох гостей.', 'Wi-Fi,Дві кімнати,Ванна,Кавомашина', 'family'],
  ];
  const insert = db.prepare('INSERT INTO rooms(number,title,category,capacity,area,price,description,amenities,image) VALUES(?,?,?,?,?,?,?,?,?)');
  transaction(db, () => rooms.forEach(r => insert.run(...r.slice(0, 8), `/images/${r[8]}.svg`)));
}
