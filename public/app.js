/** Інтерфейс АІС. Автор: Кравченко Ярослав Валентинович.
 * Браузер показує дані, а ціни, права доступу та платежі перевіряє сервер.
 */
const $ = selector => document.querySelector(selector);
const main = $('#main'), dialog = $('#dialog');
let state, currentRoom, currentBooking, editingRoom, renderVersion = 0, timer;
const names = { pending:'Очікує оплати', confirmed:'Підтверджено', checked_in:'Гість у готелі', completed:'Завершено',
  cancelled:'Скасовано', expired:'Резерв завершився', paid:'Оплачено', failed:'Оплата не вдалася',
  refund_required:'Потрібне повернення', refund_pending:'Повернення в обробці', refunded:'Кошти повернено' };
const categories = { standard:'Стандарт', deluxe:'Делюкс', suite:'Люкс', family:'Сімейний' };
// Екрануємо текст перед вставленням у HTML: ім'я користувача не може виконувати JavaScript.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => new Intl.NumberFormat('uk-UA', { maximumFractionDigits:2 }).format(cents / 100) + ' ₴';
const date = value => new Date(value + 'T12:00:00').toLocaleDateString('uk-UA', { day:'numeric', month:'short', year:'numeric' });
const datetime = value => new Date(value).toLocaleString('uk-UA', { dateStyle:'short', timeStyle:'short' });
const plusDays = (value, days) => new Date(Date.parse(value) + days * 86400000).toISOString().slice(0,10);
const badge = status => `<span class="badge ${esc(status)}">${esc(names[status] || status)}</span>`;
const field = (label, name, value = '', options = '') => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" ${options}></label>`;
const empty = (title, text, button = '') => `<div class="empty"><h3>${title}</h3><p>${text}</p>${button}</div>`;
const failBox = '<div class="form-error" role="alert"></div>';
const formValues = form => Object.fromEntries(new FormData(form));
let filters = {};

// Єдина функція обміну з сервером: JSON, CSRF-токен і зрозуміла обробка помилок.
async function api(path, options = {}) {
  const response = await fetch('/api' + path, { ...options, headers: {
    ...(options.body ? {'Content-Type':'application/json', 'X-CSRF-Token':state?.csrf || ''} : {}), ...options.headers,
  }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Не вдалося виконати запит.'); error.status = response.status; throw error; }
  return data;
}
const post = (path, body = {}) => api(path, { method:'POST', body });
function toast(message, error = false) {
  const box = $('#toast'); box.textContent = message;box.className = error ? 'error' : ''; box.hidden = false;
  clearTimeout(box.timeout);box.timeout = setTimeout(() => box.hidden = true, 5000);
}
function go(path) { if (location.hash === '#' + path) render(); else location.hash = path; }
function routeInfo() { return new URL((location.hash.slice(1) || '/'), location.origin); }
function nav() {
  const path = routeInfo().pathname;
  $('#header').innerHTML = `<div class="nav"><a class="brand" href="#/" aria-label="Готель Тиша — головна">тиша<span>HOTEL & STAY</span></a>
    <nav class="navlinks" aria-label="Основна навігація"><a href="#/" class="${path === '/' ? 'active' : ''}">Номери та ціни</a>
    ${state.user ? `<a href="#/account" class="${path === '/account' ? 'active' : ''}">Мої бронювання</a><a href="#/notifications">Сповіщення</a>` : '<a href="#/about">Про готель</a>'}
    ${state.user?.role === 'admin' ? `<a href="#/admin" class="${path.startsWith('/admin') ? 'active' : ''}">Керування</a>` : ''}</nav>
    <div class="navright"><span class="mode-chip">${state.paymentMode === 'demo' ? 'Демо' : 'LiqPay · тест'}</span>
    ${state.user ? `<span class="user-name">${esc(state.user.name)}</span><button class="text" data-action="logout">Вийти</button>` : '<a class="button secondary small" href="#/login">Увійти ↗</a>'}</div></div>`;
}
function roomCard(r) {
  return `<article class="room-card"><a href="#/room/${r.id}" class="room-picture" aria-label="${esc(r.title)}"><img src="${esc(r.image)}" alt="${esc(r.title)}" loading="lazy"><span class="room-category">${categories[r.category]}</span></a>
    <div class="room-body"><h3><a href="#/room/${r.id}">${esc(r.title)}</a></h3><div class="room-meta"><span>♙ До ${r.capacity} гостей</span><span>▱ ${r.area} м²</span><span>№ ${esc(r.number)}</span></div>
    <div class="amenities">${r.amenities.split(',').slice(0,3).map(a => `<span>${esc(a)}</span>`).join('')}</div><div class="room-bottom"><div class="price">${money(r.price)} <small>/ ніч</small></div><a href="#/room/${r.id}">Обрати номер <span>↗</span></a></div></div></article>`;
}
// Версія екрана захищає від запізнілої відповіді після переходу на іншу сторінку.
async function home(version) {
  const query = new URLSearchParams(Object.entries(filters).filter(([,v]) => v));
  const rooms = await api('/rooms?' + query);
  if (version !== renderVersion) return;
  main.innerHTML = `<section class="hero"><div><span class="eyebrow">ПОЛТАВА · МІСЦЕ ДЛЯ ВІДПОЧИНКУ</span><h1>Ваша пауза<br>починається <em>тут.</em></h1><p>Залиште метушню за дверима. Оберіть свій простір, зручні дати та подбайте про відпочинок за кілька хвилин.</p><div class="hero-points"><span>Пряме бронювання</span><span>Прозора вартість</span><span>Онлайн-оплата</span></div></div><div class="hero-visual"><img src="/images/suite.svg" alt="Ілюстрація світлого готельного номера"><span class="image-note">Простір для спокійного ранку</span></div></section>
    <form id="search" class="searchbar"><label>Заїзд<input type="date" name="start" min="${state.today}" value="${esc(filters.start)}" required></label><label>Виїзд<input type="date" name="end" min="${plusDays(filters.start,1)}" value="${esc(filters.end)}" required></label><label>Гості<select name="guests">${[1,2,3,4,5,6,7,8].map(n => `<option value="${n}" ${Number(filters.guests) === n ? 'selected':''}>${n} ${n === 1 ? 'гість' : n < 5 ? 'гості' : 'гостей'}</option>`).join('')}</select></label><label>До ₴ за ніч<input type="number" min="100" max="100000" name="maxPrice" placeholder="Без обмежень" value="${esc(filters.maxPrice || '')}"></label><button>Знайти номер <span>→</span></button>${failBox}</form>
    <div class="section-heading"><div><span class="eyebrow">ОБЕРІТЬ СВІЙ ВІДПОЧИНОК</span><h2>Номери з відчуттям дому</h2></div><p>${rooms.length} доступних номерів<br>на обрані дати</p></div><div class="filter-row"><div class="pills">${[['','Усі номери'],...Object.entries(categories)].map(([k,v]) => `<button class="pill ${filters.category === k ? 'active':''}" data-category="${k}">${v}</button>`).join('')}</div><span class="tiny muted">Ціна за номер · податки включено</span></div>
    <section class="rooms-grid" aria-label="Доступні номери">${rooms.length ? rooms.map(roomCard).join('') : empty('На ці дати вільних номерів немає','Спробуйте інші дати, категорію або кількість гостей.')}</section>
    <section class="benefits"><div><span class="benefit-icon">⌁</span><h3>Без зайвого поспіху</h3><p>Обирайте номер і плануйте подорож у зручний для себе час.</p></div><div><span class="benefit-icon">◇</span><h3>Усе зрозуміло заздалегідь</h3><p>Повна вартість та умови скасування до підтвердження бронювання.</p></div><div><span class="benefit-icon">☷</span><h3>Подорож під контролем</h3><p>Дати, стан оплати й усі ваші бронювання в особистому кабінеті.</p></div></section>`;
}
async function roomPage(id, version) {
  const rooms = await api('/rooms');
  if (version !== renderVersion) return;
  const r = currentRoom = rooms.find(r => r.id === Number(id));
  if (!r) throw Error('Номер недоступний. Поверніться до каталогу.');
  main.innerHTML = `<div class="page-head"><a class="breadcrumb" href="#/">← Усі номери</a><span class="eyebrow">${categories[r.category]} · № ${esc(r.number)}</span><h1>${esc(r.title)}</h1></div><div class="split"><section><img class="detail-image" src="${esc(r.image)}" alt="${esc(r.title)}"><div class="detail-description"><div class="room-meta"><span>До ${r.capacity} гостей</span><span>${r.area} м²</span></div><h2>Ваш простір для відпочинку</h2><p>${esc(r.description)}</p><div class="amenities">${r.amenities.split(',').map(a => `<span>${esc(a)}</span>`).join('')}</div><p class="tiny muted">${r.image.endsWith('.svg') ? 'Зображення — ілюстрація демонстраційного номера.' : 'Фотографію додано адміністрацією готелю.'}</p><div class="notice">Номер резервується на 15 хвилин. Бронювання підтверджується після успішної оплати.</div><details class="policy" open><summary>Умови бронювання та скасування</summary>${esc(state.policy)}</details></div></section>
    <section class="panel sticky"><h3>Забронювати перебування</h3><p class="price">${money(r.price)} <small>/ ніч</small></p><form id="book"><div class="form-grid">${field('Заїзд','start',filters.start,`type="date" min="${state.today}" required`)}${field('Виїзд','end',filters.end,`type="date" min="${plusDays(filters.start,1)}" required`)}${field('Кількість гостей','guests',Math.min(r.capacity,Number(filters.guests)),`type="number" min="1" max="${r.capacity}" required`)}<div></div></div>
    ${field('Ім’я та прізвище','name',state.user?.name || '', 'autocomplete="name" minlength="2" maxlength="100" required')}${field('Електронна пошта','email',state.user?.email || '', 'type="email" autocomplete="email" required')}${field('Телефон','phone',state.user?.phone || '', 'type="tel" autocomplete="tel" minlength="7" maxlength="25" required')}
    <div id="quote"></div><label class="checkbox"><input type="checkbox" name="acceptPolicy" required><span>Погоджуюся з умовами бронювання та скасування, наведеними на цій сторінці.</span></label>${failBox}
    ${state.user ? '<button class="wide">Забронювати та перейти до оплати →</button>' : `<a class="button wide" href="#/login?next=/room/${r.id}">Увійти для бронювання →</a>`}</form><p class="tiny muted">Вартість остаточно перевіряється сервером під час бронювання.</p></section></div>`;
  updateQuote();
}
// Попередній розрахунок допомагає гостю; остаточну суму повторно обчислює сервер.
function updateQuote() {
  const form = $('#book'); if (!form || !currentRoom) return;
  const values = formValues(form), count = (Date.parse(values.end) - Date.parse(values.start)) / 86400000;
  $('#quote').innerHTML = count > 0 && count <= 90 ? `<div class="summary-line"><span>${money(currentRoom.price)} × ${count} ноч.</span><span>${money(currentRoom.price * count)}</span></div><div class="summary-line summary-total"><span>Разом</span><span>${money(currentRoom.price * count)}</span></div>` : '<div class="notice warn">Оберіть коректні дати — до 90 ночей.</div>';
}
function authPage(register, next) {
  main.innerHTML = `<div class="auth-wrap"><a class="breadcrumb" href="#/">← До номерів</a><div class="panel"><span class="eyebrow">ВАШ ОСОБИСТИЙ ПРОСТІР</span><h1>${register ? 'Раді знайомству' : 'З поверненням'}</h1><p class="muted">${register ? 'Створіть обліковий запис, щоб планувати подорожі.' : 'Увійдіть, щоб керувати своїми бронюваннями.'}</p><form id="${register ? 'register' : 'login'}" data-next="${esc(next || '/account')}">
    ${register ? field('Ім’я та прізвище','name','', 'autocomplete="name" minlength="2" maxlength="100" required') : ''}${field('Електронна пошта','email','', 'type="email" autocomplete="email" required')}${register ? field('Телефон','phone','', 'type="tel" autocomplete="tel" minlength="7" maxlength="25" required') : ''}${field('Пароль','password','', `type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="${register ? 10 : 1}" maxlength="128" required`)}${register ? '<p class="tiny muted">Щонайменше 10 символів.</p>' : ''}${failBox}<button class="wide">${register ? 'Створити обліковий запис' : 'Увійти'} →</button></form><p class="auth-switch">${register ? 'Уже маєте обліковий запис?' : 'Вперше тут?'} <a href="#/${register ? 'login' : 'register'}?next=${encodeURIComponent(next || '/account')}">${register ? 'Увійти' : 'Зареєструватися'}</a></p></div></div>`;
}
function bookingCard(b) {
  return `<article class="booking-card"><img src="${esc(b.room_image)}" alt="${esc(b.room_title)}"><div><span class="booking-number">БРОНЮВАННЯ ${b.id.slice(0,8).toUpperCase()}</span><h3>${esc(b.room_title)}</h3><p>${date(b.check_in)} — ${date(b.check_out)} · ${b.guests} гост.</p>${badge(b.status)} ${b.cancel_requested ? '<span class="badge refund_pending">Запит на скасування</span>' : ''}</div><div class="right"><p class="price">${money(b.total)}</p><a class="button secondary small" href="#/booking/${b.id}">Деталі →</a></div></article>`;
}
async function accountPage(version) {
  const rows = await api('/bookings');if (version !== renderVersion) return;
  const mine = rows.filter(b => b.user_id === state.user.id);
  main.innerHTML = `<div class="page-head"><span class="eyebrow">ОСОБИСТИЙ КАБІНЕТ</span><h1>Ваші наступні подорожі</h1><p class="muted">Вітаємо, ${esc(state.user.name)}. Усі деталі відпочинку — в одному місці.</p></div><section class="booking-list">${mine.length ? mine.map(bookingCard).join('') : empty('Час спланувати відпочинок','У вас поки немає бронювань. Оберіть номер для першої подорожі.','<a class="button" href="#/">Переглянути номери →</a>')}</section>`;
}
async function bookingPage(id, version) {
  const b = await api(`/bookings/${id}`);if (version !== renderVersion) return; currentBooking = b;
  const mine = b.user_id === state.user.id;
  main.innerHTML = `<div class="page-head"><a class="breadcrumb" href="#/${state.user.role === 'admin' ? 'admin' : 'account'}">← До бронювань</a><span class="eyebrow">БРОНЮВАННЯ ${b.id.slice(0,8).toUpperCase()}</span><h1>${esc(b.room_title)}</h1>${badge(b.status)} ${b.cancel_requested ? '<span class="badge refund_pending">Очікує погодження скасування</span>' : ''}</div><div class="split"><div><section class="panel"><h3>Деталі вашого перебування</h3><div class="summary-line"><span class="muted">Заїзд</span><strong>${date(b.check_in)}</strong></div><div class="summary-line"><span class="muted">Виїзд</span><strong>${date(b.check_out)}</strong></div><div class="summary-line"><span class="muted">Номер / гості</span><strong>№ ${esc(b.room_number)} / ${b.guests}</strong></div><div class="summary-line"><span class="muted">Гість</span><strong>${esc(b.contact_name)}</strong></div><div class="summary-line"><span class="muted">Email</span><span>${esc(b.contact_email)}</span></div><div class="summary-line"><span class="muted">Телефон</span><span>${esc(b.contact_phone)}</span></div><div class="summary-line"><span class="muted">Вартість за ніч</span><span>${money(b.nightly_price)}</span></div><div class="summary-line summary-total"><span>Разом</span><span>${money(b.total)}</span></div></section>
    <section class="panel"><h3>Історія платежів</h3>${b.payments.length ? b.payments.map(p => `<div class="mail-item"><div class="summary-line"><span>${p.provider === 'demo' ? 'Демонстраційний платіж' : 'LiqPay · тест'}<br><small class="muted">${datetime(p.created_at)}</small></span><strong>${money(p.amount)}</strong></div>${badge(p.status)} ${p.provider === 'liqpay' && !['refunded','failed'].includes(p.status) ? `<button class="text" data-sync="${p.id}">Перевірити в LiqPay</button>` : ''}${state.user.role === 'admin' && p.status === 'refund_required' ? `<button class="secondary small" data-refund="${p.id}">Повернути кошти</button>` : ''}${p.refund_error ? `<p class="tiny">${esc(p.refund_error)}</p>`:''}</div>`).join('') : '<p class="muted">Оплату ще не розпочато.</p>'}</section>
    ${state.user.role === 'admin' ? `<section class="panel"><h3>Дії адміністратора</h3>${b.cancel_reason ? `<p class="muted">Причина скасування: ${esc(b.cancel_reason)}</p>` : ''}<div class="actions">${b.cancel_requested ? `<button data-admin-action="approve_cancel">Погодити скасування</button><button class="secondary" data-admin-action="reject_cancel">Відхилити</button>` : ''}${b.status === 'confirmed' && !b.cancel_requested ? '<button data-admin-action="check_in">Зареєструвати заселення</button>' : ''}${b.status === 'checked_in' ? '<button data-admin-action="check_out">Зареєструвати виїзд</button>' : ''}${!['confirmed','checked_in'].includes(b.status) ? '<p class="muted">Додаткових дій із проживанням немає.</p>' : ''}</div></section>`:''}</div>
    <aside class="panel sticky">${b.status === 'pending' ? `<div class="steps"><span>01 НОМЕР</span><span class="current">02 ОПЛАТА</span><span>03 ВІДПОЧИНОК</span></div><h2>Майже готово</h2><p class="muted">Оплатіть бронювання, щоб підтвердити свій відпочинок.</p><div class="notice warn">Резерв діє ще <strong id="countdown"></strong></div>${mine ? '<button class="wide" data-action="checkout">Перейти до оплати →</button>' : ''}` : b.status === 'confirmed' ? '<div class="check-symbol">✓</div><h2>На вас чекають</h2><p class="muted">Оплату підтверджено. Деталі перебування збережено у вашому кабінеті.</p>' : `<h2>${names[b.status]}</h2><p class="muted">Поточний стан бронювання та платежів наведено поруч.</p>`}
    <button class="text" data-action="refresh">Оновити статус</button><details class="policy" open><summary>Умови скасування</summary>${esc(b.policy)}</details>
    ${mine && ['pending','confirmed'].includes(b.status) && !b.cancel_requested ? '<button class="danger wide" data-action="cancel-booking">Скасувати бронювання</button>' : ''}<p class="tiny muted">${state.mailEnabled ? 'Листи очікують відправлення поштовим модулем.' : 'Листи зберігаються в демонстраційній поштовій черзі; зовнішнє надсилання не налаштовано.'}</p></aside></div>`;
  if (b.status === 'pending') {
    const tick = () => {
      const seconds = Math.max(0,Math.ceil((b.expires_at - (Date.now() + state.timeOffset)) / 1000));
      const box = $('#countdown');if (box) box.textContent = `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
      if (!seconds) {clearInterval(timer);render();}
    };tick();timer = setInterval(tick,1000);
  }
}
function adminTabs(tab) {
  return `<div class="page-head"><span class="eyebrow">ПАНЕЛЬ АДМІНІСТРАТОРА</span><h1>Усе під контролем</h1></div><nav class="admin-tabs" aria-label="Розділи керування">${[['overview','Огляд'],['bookings','Бронювання'],['rooms','Номери'],['calendar','Календар'],['reports','Звіти'],['mail','Поштова черга'],['audit','Журнал дій']].map(([k,v])=>`<a href="#/admin/${k}" class="${tab===k?'active':''}">${v}</a>`).join('')}</nav>`;
}
function bookingTable(rows) {
  return rows.length ? `<div class="table-wrap"><table><thead><tr><th>Бронювання / гість</th><th>Номер</th><th>Період</th><th>Сума</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(b=>`<tr><td><strong>${esc(b.contact_name)}</strong><small>${esc(b.contact_email)}<br>${b.id.slice(0,8)}</small></td><td>№ ${esc(b.room_number)}<br><small>${esc(b.room_title)}</small></td><td>${date(b.check_in)}<br><small>до ${date(b.check_out)}</small></td><td>${money(b.total)}</td><td>${badge(b.status)}${b.cancel_requested?'<br><span class="badge refund_pending">Скасування</span>':''}</td><td><a class="button secondary small" href="#/booking/${b.id}">Відкрити</a></td></tr>`).join('')}</tbody></table></div>`:empty('Бронювань поки немає','Нові замовлення з’являться тут.');
}
async function adminPage(tab, version, params) {
  let html = adminTabs(tab);
  if (['overview','bookings'].includes(tab)) {
    const search = params.get('search') || '', status = params.get('status') || '';
    const rows = await api('/admin/bookings?' + new URLSearchParams({search,status}));
    if (tab === 'overview') {
      const active = rows.filter(b=>['confirmed','checked_in'].includes(b.status));
      html += `<div class="stats"><div class="stat"><span>Підтверджені та заселені</span><strong>${active.length}</strong></div><div class="stat"><span>Очікують оплати</span><strong>${rows.filter(b=>b.status==='pending').length}</strong></div><div class="stat"><span>Запити на скасування</span><strong>${rows.filter(b=>b.cancel_requested).length}</strong></div><div class="stat"><span>Повернення потребують уваги</span><strong>${rows.flatMap(b=>b.payments).filter(p=>['refund_required','refund_pending'].includes(p.status)).length}</strong></div></div><div class="section-title"><h2>Останні бронювання</h2><a class="button secondary small" href="#/admin/bookings">Переглянути всі →</a></div>${bookingTable(rows.slice(0,12))}`;
    } else html += `<form id="admin-search" class="toolbar">${field('Клієнт, email, номер або код','search',search,'placeholder="Пошук бронювання"')}<label class="field"><span>Статус</span><select name="status"><option value="">Усі</option>${['pending','confirmed','checked_in','completed','cancelled','expired'].map(s=>`<option value="${s}" ${s===status?'selected':''}>${names[s]}</option>`).join('')}</select></label><button>Знайти</button></form>${bookingTable(rows)}`;
  } else if (tab === 'rooms') {
    const rooms = await api('/admin/rooms');window.adminRooms = rooms;
    html += `<div class="section-title"><h2>Номерний фонд</h2><button data-action="add-room">+ Додати номер</button></div><p class="muted tiny">Вимкнення номера прибирає його з нового пошуку. Наявні бронювання зберігаються.</p><div class="table-wrap"><table><thead><tr><th>Фото</th><th>Номер</th><th>Категорія</th><th>Місткість</th><th>Ціна за ніч</th><th>Доступність</th><th></th></tr></thead><tbody>${rooms.map(r=>`<tr><td><img class="thumb" src="${esc(r.image)}" alt=""></td><td><strong>№ ${esc(r.number)} · ${esc(r.title)}</strong></td><td>${categories[r.category]}</td><td>${r.capacity} гост.</td><td>${money(r.price)}</td><td>${r.active?'Відкритий':'Закритий'}</td><td><button class="secondary small" data-edit-room="${r.id}">Редагувати</button></td></tr>`).join('')}</tbody></table></div>`;
  } else if (tab === 'calendar') {
    const start = params.get('start') || state.today, end = plusDays(start,14);
    const result = await api('/admin/calendar?' + new URLSearchParams({start,end}));
    const days = Array.from({length:14},(_,i)=>plusDays(start,i));
    html += `<form id="calendar-filter" class="toolbar">${field('Початок періоду (14 днів)','start',start,'type="date" required')}<button>Показати</button></form><p class="tiny muted">Зелений — підтверджено / заселено · жовтий — тимчасовий резерв · синій — завершено</p><div class="table-wrap"><table class="calendar"><thead><tr><th>Номер</th>${days.map(d=>`<th>${d.slice(8)}.${d.slice(5,7)}</th>`).join('')}</tr></thead><tbody>${result.rooms.map(r=>`<tr><td><strong>№ ${esc(r.number)}</strong><small>${esc(r.title)}</small></td>${days.map(d=>{const b=result.bookings.find(b=>b.room_id===r.id && b.check_in<=d && b.check_out>d);return `<td class="${b?(b.status==='pending'?'cell-pending':b.status==='completed'?'cell-done':'cell-booked'):''} ${d===state.today?'cell-today':''}">${b?`<a href="#/booking/${b.id}" title="${esc(b.contact_name)}">${esc(b.contact_name.split(' ')[0])}</a>`:'·'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (tab === 'reports') {
    const start=params.get('start')||state.today.slice(0,8)+'01',end=params.get('end')||plusDays(state.today,1);
    const query=new URLSearchParams({start,end}), r=await api('/admin/report?'+query);
    html += `<form id="report-filter" class="toolbar">${field('Початок','start',start,'type="date" required')}${field('Кінець (не включно)','end',end,'type="date" required')}<button>Сформувати</button><a class="button secondary" href="/api/admin/report.csv?${query}">Завантажити CSV ↓</a></form><div class="stats"><div class="stat"><span>Надійшло за період</span><strong>${money(r.received)}</strong></div><div class="stat"><span>Повернено за період</span><strong>${money(r.refunded)}</strong></div><div class="stat"><span>Різниця надходжень і повернень</span><strong>${money(r.net)}</strong></div><div class="stat"><span>Завантаження номерів</span><strong>${r.occupancy}%</strong></div></div><section class="panel"><h3>Показники бронювання</h3><div class="summary-line"><span>Бронювань із проживанням у періоді</span><strong>${r.bookings}</strong></div><div class="summary-line"><span>Підтверджені / заселені / завершені</span><strong>${r.confirmed}</strong></div><div class="summary-line"><span>Скасовані або прострочені</span><strong>${r.cancelled}</strong></div><div class="summary-line"><span>Заброньовані ночі / загальна місткість у ночах</span><strong>${r.reservedNights} / ${r.capacityNights}</strong></div><p class="tiny muted">Грошові показники враховують дату оплати чи повернення за київським часом. Завантаження — частка підтверджених, заселених і завершених ночей серед усіх номерів; тимчасові резерви виключено. Дані тестових платежів є навчальними.</p></section>`;
  } else if (tab === 'mail') {
    const rows=await api('/admin/mail');
    html += `<section class="panel"><h2>Поштова черга</h2><p class="muted">${state.mailEnabled?'Поштовий API налаштовано. Відправлення виконує команда npm run mail.':'Зовнішню пошту не підключено. Тут можна переглянути листи, сформовані для клієнтів.'}</p>${rows.length?rows.map(m=>`<details class="mail-item"><summary><span><strong>${esc(m.subject)}</strong><br><span class="tiny muted">${esc(m.recipient)} · ${datetime(m.created_at)}</span></span><span class="badge">${m.sent_at?'Надіслано':m.error?'Помилка надсилання':'У черзі'}</span></summary><pre>${esc(m.body)}</pre>${m.error?`<p class="form-error">${esc(m.error)}</p>`:''}</details>`).join(''):'<p>Листів поки немає.</p>'}</section>`;
  } else if (tab === 'audit') {
    const rows=await api('/admin/audit');
    html += `<div class="table-wrap"><table><thead><tr><th>Час</th><th>Користувач</th><th>Дія</th><th>Об’єкт</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${datetime(r.created_at)}</td><td>${esc(r.name||'Платіжний сервіс')}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')}</tbody></table></div>`;
  } else throw Error('Розділ не знайдено.');
  if (version===renderVersion)main.innerHTML=html;
}
function openModal(html) { $('#dialog-content').innerHTML=html;dialog.showModal(); }
function modalHeader(title) { return `<div class="modal-head"><h2>${title}</h2><button class="close" data-action="close-modal" aria-label="Закрити">×</button></div>`; }
function roomEditor(id) {
  const r=editingRoom=id?window.adminRooms.find(r=>r.id===Number(id)):null;
  openModal(`${modalHeader(r?'Редагувати номер':'Новий номер')}<form id="room-editor"><div class="form-grid">${field('Номер','number',r?.number||'','required maxlength="10"')}${field('Назва','title',r?.title||'','required minlength="3" maxlength="80"')}<label class="field"><span>Категорія</span><select name="category">${Object.entries(categories).map(([k,v])=>`<option value="${k}" ${r?.category===k?'selected':''}>${v}</option>`).join('')}</select></label>${field('Місткість','capacity',r?.capacity||2,'type="number" min="1" max="8" required')}${field('Площа, м²','area',r?.area||22,'type="number" min="10" max="300" required')}${field('Ціна за ніч, грн','price',r?r.price/100:1800,'type="number" min="100" max="100000" step="0.01" required')}</div><label class="field"><span>Опис</span><textarea name="description" required minlength="10" maxlength="2000">${esc(r?.description||'')}</textarea></label>${field('Зручності (через кому)','amenities',r?.amenities||'Wi-Fi,Кондиціонер','required maxlength="300"')}<label class="field"><span>Ілюстрація</span><select name="image">${['standard','garden','deluxe','family','suite'].map(n=>`<option value="/images/${n}.svg" ${r?.image===`/images/${n}.svg`?'selected':''}>${{standard:'Стандарт',garden:'Сад',deluxe:'Делюкс',family:'Сімейний',suite:'Люкс'}[n]}</option>`).join('')}${r?.image.startsWith('/uploads/')?`<option value="${esc(r.image)}" selected>Завантажене фото</option>`:''}</select></label><label class="field"><span>Або завантажте фото (PNG / JPEG, до 2 МБ)</span><input type="file" id="photo-upload" accept="image/png,image/jpeg"></label><label class="checkbox"><input type="checkbox" name="active" ${!r||r.active?'checked':''}>Доступний для нових бронювань</label>${failBox}<button class="wide">Зберегти номер</button></form>`);
}

async function render() {
  clearInterval(timer);const version=++renderVersion;nav();main.innerHTML='<div class="loading">Завантажуємо…</div>';
  const url=routeInfo(),path=url.pathname;
  if (['/account','/notifications'].includes(path)||path.startsWith('/booking/')||path.startsWith('/admin')) {
    if(!state.user){go('/login?next='+encodeURIComponent(path+url.search));return;}
    if(path.startsWith('/admin')&&state.user.role!=='admin'){main.innerHTML=empty('Доступ обмежено','Цей розділ доступний лише адміністратору.');return;}
  }
  try {
    if(path==='/')await home(version);
    else if(path.startsWith('/room/'))await roomPage(path.split('/')[2],version);
    else if(path==='/login'||path==='/register')authPage(path==='/register',url.searchParams.get('next'));
    else if(path==='/account')await accountPage(version);
    else if(path.startsWith('/booking/'))await bookingPage(path.split('/')[2],version);
    else if(path.startsWith('/admin'))await adminPage(path.split('/')[2]||'overview',version,url.searchParams);
    else if(path==='/notifications'){
      const rows=await api('/notifications');if(version!==renderVersion)return;
      main.innerHTML=`<div class="page-head"><span class="eyebrow">ОСОБИСТИЙ КАБІНЕТ</span><h1>Сповіщення</h1></div><section class="panel notifications">${rows.length?rows.map(n=>`<a class="notification ${n.is_read?'':'unread'}" href="#/booking/${n.booking_id}"><span>${esc(n.message)}</span><time>${datetime(n.created_at)}</time></a>`).join(''):'Нових повідомлень немає.'}</section>`;await post('/notifications/read');
    } else if(path==='/about')main.innerHTML=`<div class="page-head"><span class="eyebrow">ГОТЕЛЬ ТИША</span><h1>Простір для вашої паузи</h1></div><section class="panel"><p>«Тиша» — навчальний готель для демонстрації автоматизованої інформаційної системи бронювання. Каталог, кабінет клієнта та панель адміністратора працюють зі спільною базою даних.</p><h3>Як забронювати</h3><ol><li>Оберіть дати проживання та кількість гостей.</li><li>Оберіть номер, увійдіть і заповніть контактні дані.</li><li>Перегляньте умови та завершіть тестову оплату за 15 хвилин.</li><li>Перевірте підтвердження в особистому кабінеті.</li></ol><div class="notice">${esc(state.policy)}</div><p class="muted">Автор: Кравченко Ярослав Валентинович · група 45.</p><a class="button" href="#/">Обрати номер →</a></section>`;
    else main.innerHTML=empty('Сторінку не знайдено','Поверніться до каталогу номерів.','<a class="button" href="#/">На головну</a>');
  }catch(error){if(version===renderVersion)main.innerHTML=empty('Не вдалося завантажити',esc(error.message),'<button data-action="refresh">Спробувати ще раз</button>');}
}

// Делегування подій працює і після заміни вмісту сторінки без повторних підписок.
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.id)return;event.preventDefault();
  const button=form.querySelector('button[type="submit"],button:not([type])'),errorBox=form.querySelector('.form-error');
  if(errorBox)errorBox.textContent='';if(button)button.disabled=true;
  try{
    const data=formValues(form);
    if(form.id==='search'){filters={...filters,...data};await render();}
    else if(form.id==='login'||form.id==='register'){
      const result=await post('/'+form.id,data);state={...state,...result};
      const next=form.dataset.next;go(next?.startsWith('/')&&!next.startsWith('//')?next:'/account');toast('Ви увійшли до системи.');
    }else if(form.id==='book'){
      const b=await post('/bookings',{...data,roomId:currentRoom.id,acceptPolicy:form.elements.acceptPolicy.checked});
      filters={...filters,start:data.start,end:data.end,guests:data.guests};go('/booking/'+b.id);toast('Номер зарезервовано на 15 хвилин.');
    }else if(form.id==='admin-search')go('/admin/bookings?'+new URLSearchParams(data));
    else if(form.id==='calendar-filter')go('/admin/calendar?'+new URLSearchParams(data));
    else if(form.id==='report-filter')go('/admin/reports?'+new URLSearchParams(data));
    else if(form.id==='room-editor'){
      await api('/admin/rooms'+(editingRoom?'/'+editingRoom.id:''),{method:editingRoom?'PUT':'POST',body:{...data,active:form.elements.active.checked}});
      dialog.close();await render();toast('Дані номера збережено.');
    }else if(form.id==='cancel-form'){
      await post(`/bookings/${currentBooking.id}/cancel`,data);dialog.close();await render();toast('Запит опрацьовано.');
    }
  }catch(error){if(errorBox)errorBox.textContent=error.message;else toast(error.message,true);}
  finally{if(button)button.disabled=false;}
});
document.addEventListener('change',async event=>{
  const input=event.target;
  if(input.name==='start'&&input.value&&Number.isFinite(Date.parse(input.value))&&input.form && ['book','search'].includes(input.form.id)){
    const end=input.form.elements.end;end.min=plusDays(input.value,1);if(end.value<=input.value)end.value=plusDays(input.value,1);
  }
  if(input.closest('#book'))updateQuote();
  if(input.id==='photo-upload'&&input.files[0]){
    const file=input.files[0],form=input.form;const button=form.querySelector('button');button.disabled=true;
    try{
      if(file.size>2*1024*1024)throw Error('Файл має бути до 2 МБ.');
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
      const result=await post('/admin/upload',{data});
      const option=new Option('Завантажене фото',result.image,true,true);form.elements.image.add(option);toast('Фото завантажено. Збережіть номер.');
    }catch(error){form.querySelector('.form-error').textContent=error.message;}finally{button.disabled=false;}
  }
});
document.addEventListener('click',async event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.category!==undefined){filters.category=target.dataset.category;render();return;}
  if(target.dataset.editRoom){roomEditor(target.dataset.editRoom);return;}
  const action=target.dataset.action;
  if(action==='close-modal'){dialog.close();return;}
  if(action==='add-room'){roomEditor();return;}
  if(action==='cancel-booking'){
    openModal(`${modalHeader('Скасування бронювання')}<p class="muted">${esc(currentBooking.policy)}</p><form id="cancel-form"><label class="field"><span>Причина</span><textarea name="reason" minlength="2" maxlength="500" required placeholder="Коротко опишіть причину"></textarea></label>${failBox}<button class="danger wide">Підтвердити запит</button></form>`);return;
  }
  if(!action&&!target.dataset.simulate&&!target.dataset.adminAction&&!target.dataset.refund&&!target.dataset.sync)return;
  target.disabled=true;
  try{
    if(action==='logout'){await post('/logout');state=await api('/me');state.timeOffset=state.now-Date.now();go('/');}
    if(action==='refresh')await render();
    if(action==='checkout'){
      const result=await post(`/bookings/${currentBooking.id}/checkout`);
      if(result.mode==='demo')openModal(`${modalHeader('Демонстраційна оплата')}<span class="mode-chip">БЕЗ СПИСАННЯ КОШТІВ</span><p class="muted">Це навчальний симулятор. Він дає змогу перевірити успішну та невдалу оплату без введення банківської картки.</p><div class="summary-line summary-total"><span>До оплати</span><span>${money(result.payment.amount)}</span></div><div class="payment-choice"><button data-simulate="success" data-payment="${result.payment.id}">Підтвердити тестову оплату</button><button class="secondary" data-simulate="failure" data-payment="${result.payment.id}">Перевірити відмову в оплаті</button></div>`);
      else{
        // Дані картки вводяться на стороні LiqPay; наш сайт передає лише підписане замовлення.
        const form=document.createElement('form');form.method='POST';form.action=result.url;
        for(const key of ['data','signature']){const input=document.createElement('input');input.type='hidden';input.name=key;input.value=result[key];form.append(input);}
        document.body.append(form);form.submit();
      }
    }
    if(target.dataset.simulate){await post(`/payments/${target.dataset.payment}/simulate`,{outcome:target.dataset.simulate});dialog.close();await render();toast(target.dataset.simulate==='success'?'Тестову оплату підтверджено.':'Спроба оплати завершилася відмовою.');}
    if(target.dataset.adminAction){await post(`/admin/bookings/${currentBooking.id}/action`,{action:target.dataset.adminAction});await render();toast('Стан бронювання оновлено.');}
    if(target.dataset.refund){if(!confirm('Підтвердити повне повернення коштів за цим тестовим платежем?'))return;await post(`/admin/payments/${target.dataset.refund}/refund`);await render();toast('Запит на повернення опрацьовано.');}
    if(target.dataset.sync){await post(`/payments/${target.dataset.sync}/sync`);await render();toast('Отримано актуальний стан платежу.');}
  }catch(error){toast(error.message,true);}finally{target.disabled=false;}
});
window.addEventListener('hashchange',()=>{dialog.close();window.scrollTo(0,0);render();});
try{
  state=await api('/me');state.timeOffset=state.now-Date.now();
  filters={start:plusDays(state.today,1),end:plusDays(state.today,3),guests:'2',category:''};
  await render();
}catch(error){main.innerHTML=empty('Немає зв’язку із сервером',esc(error.message),'<a class="button" href="/">Оновити сторінку</a>');}

