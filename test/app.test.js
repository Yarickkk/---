import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';
import { sign, pack } from '../src/payments.js';
import { sendQueuedMail } from '../src/mail.js';

// Тести використовують окрему БД у пам'яті й не змінюють демонстраційні дані.
async function fixture(t, extra = {}) {
  const base = path.join(ROOT,'test-results');mkdirSync(base,{recursive:true});
  const dir = mkdtempSync(path.join(base,'case-'));
  const clock = { now:Date.UTC(2026,9,26,10) };
  const app = createApp({ database:':memory:',dataDir:dir,adminPassword:'TestAdmin2026!',now:()=>clock.now,...extra });
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie='',csrf='';
    return {
      async request(route,body,method=body?'POST':'GET',headers={}) {
        const r=await fetch(baseUrl+'/api'+route,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{}),...headers},body:body?JSON.stringify(body):undefined});
        const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
        const data=await r.json();if(data.csrf)csrf=data.csrf;
        return {status:r.status,data};
      },
      async register(n=1) {
        await this.request('/me');
        const r=await this.request('/register',{name:`Клієнт ${n}`,email:`guest${n}@example.test`,phone:'+380501234567',password:'MyPassword2026!'});
        assert.equal(r.status,201);return r.data.user;
      },
      async admin(){await this.request('/me');const r=await this.request('/login',{email:'admin@hotel.local',password:'TestAdmin2026!'});assert.equal(r.status,200);return r.data.user;},
    };
  }
  const c=client();const user=await c.register();
  const booking={roomId:1,start:'2026-11-03',end:'2026-11-06',guests:2,name:'Ярослав Кравченко',email:'guest1@example.test',phone:'+380501234567',acceptPolicy:true};
  async function book(overrides={}){const r=await c.request('/bookings',{...booking,...overrides});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
  async function pay(id,outcome='success'){const r=await c.request(`/bookings/${id}/checkout`,{});assert.equal(r.status,200);const pid=r.data.payment.id;const result=await c.request(`/payments/${pid}/simulate`,{outcome});assert.equal(result.status,200);return pid;}
  return {...app,clock,baseUrl,client,c,user,booking,book,pay};
}

test('реєстрація: хеш пароля, роль клієнта, дублювання email',async t=>{
  const f=await fixture(t);const u=f.db.prepare('SELECT * FROM users WHERE id=?').get(f.user.id);
  assert.notEqual(u.password_hash,'MyPassword2026!');assert.equal(u.role,'client');assert.match(u.password_hash,/^[a-f0-9]+:[a-f0-9]+$/);
  const r=await f.c.request('/register',{name:'Інший',email:'GUEST1@example.test',phone:'+380501234567',password:'Password2026!',role:'admin'});
  assert.equal(r.status,409);
});
test('CSRF і права адміністратора перевіряються сервером',async t=>{
  const f=await fixture(t);
  assert.equal((await f.c.request('/bookings',f.booking,'POST',{'X-CSRF-Token':'forged'})).status,403);
  assert.equal((await f.c.request('/admin/rooms')).status,403);
  assert.equal((await f.c.request('/bookings',f.booking,'POST',{Origin:'https://evil.test'})).status,403);
});
test('два одночасні запити на той самий номер дають одне бронювання',async t=>{
  const f=await fixture(t);const other=f.client();await other.register(2);
  const results=await Promise.all([f.c.request('/bookings',f.booking),other.request('/bookings',{...f.booking,email:'guest2@example.test'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM bookings').get().n,1);
});
test('суміжні дати дозволені; перетин і надмірна місткість відхиляються',async t=>{
  const f=await fixture(t);await f.book();await f.book({start:'2026-11-06',end:'2026-11-08'});
  assert.equal((await f.c.request('/bookings',{...f.booking,start:'2026-11-05',end:'2026-11-07'})).status,409);
  assert.equal((await f.c.request('/bookings',{...f.booking,roomId:2,guests:3})).status,400);
});
test('некоректні дати та відсутня згода не приймаються',async t=>{
  const f=await fixture(t);
  for(const patch of [{start:'2026-02-30'},{start:'2026-10-01'},{end:'2026-11-02'},{acceptPolicy:false},{guests:-1}]){
    assert.equal((await f.c.request('/bookings',{...f.booking,...patch})).status,400);
  }
});
test('ціна фіксується на сервері, зміна тарифу не змінює бронювання',async t=>{
  const f=await fixture(t);const b=await f.book({total:1,nightly_price:1});assert.equal(b.total,540000);
  f.db.prepare('UPDATE rooms SET price=999999 WHERE id=1').run();
  const r=await f.c.request(`/bookings/${b.id}/checkout`,{});assert.equal(r.data.payment.amount,540000);
});
test('прострочений резерв звільняє номер, запізніла оплата потребує повернення',async t=>{
  const f=await fixture(t);const b=await f.book();
  const checkout=await f.c.request(`/bookings/${b.id}/checkout`,{});const p=checkout.data.payment;
  f.clock.now+=16*60*1000;
  const next=await f.book();assert.notEqual(next.id,b.id);
  await f.c.request(`/payments/${p.id}/simulate`,{outcome:'success'});
  const detail=(await f.c.request(`/bookings/${b.id}`)).data;
  assert.equal(detail.status,'expired');assert.equal(detail.payments[0].status,'refund_required');
});
test('невдала оплата допускає нову спробу, успішна — підтверджує',async t=>{
  const f=await fixture(t);const b=await f.book();const first=await f.pay(b.id,'failure');const second=await f.pay(b.id);
  assert.notEqual(first,second);const r=(await f.c.request(`/bookings/${b.id}`)).data;
  assert.equal(r.status,'confirmed');assert.equal(r.payments.filter(p=>p.status==='paid').length,1);
});
test('повторна успішна подія і подія failure після success не псують оплату',async t=>{
  const f=await fixture(t);const b=await f.book();const id=await f.pay(b.id);
  const before=f.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n;
  await f.c.request(`/payments/${id}/simulate`,{outcome:'success'});
  await f.c.request(`/payments/${id}/simulate`,{outcome:'failure'});
  assert.equal(f.db.prepare('SELECT status FROM payments WHERE id=?').get(id).status,'paid');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_outbox').get().n,before);
});
test('повторний checkout повертає ту саму активну спробу',async t=>{
  const f=await fixture(t);const b=await f.book();
  const a=await f.c.request(`/bookings/${b.id}/checkout`,{}),c=await f.c.request(`/bookings/${b.id}/checkout`,{});
  assert.equal(a.data.payment.id,c.data.payment.id);
});

test('повернення запізнілої зайвої оплати зберігає бронювання, оплачене іншою спробою',async t=>{
  const f=await fixture(t);const b=await f.book();
  const old=await f.pay(b.id,'failure'),current=await f.pay(b.id);
  await f.c.request(`/payments/${old}/simulate`,{outcome:'success'});
  const admin=f.client();await admin.admin();
  assert.equal((await admin.request(`/admin/payments/${old}/refund`,{})).status,200);
  const detail=(await f.c.request(`/bookings/${b.id}`)).data;
  assert.equal(detail.status,'confirmed');
  assert.equal(detail.payments.find(p=>p.id===old).status,'refunded');
  assert.equal(detail.payments.find(p=>p.id===current).status,'paid');
});

test('черга email: без ключа немає мережі, помилка допускає повтор, успіх не дублюється',async t=>{
  const f=await fixture(t);await f.book();
  let calls=0;
  const sent=[];
  const sender=async(url,options)=>{calls++;sent.push(options);return {ok:calls>1,status:calls>1?200:503};};
  assert.equal((await sendQueuedMail(f.db,{...f.config,mailKey:''},sender)).skipped,true);
  assert.equal(calls,0);
  const config={...f.config,mailKey:'test-only',mailFrom:'hotel@example.test'};
  await sendQueuedMail(f.db,config,sender);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_outbox WHERE sent_at IS NULL').get().n,1);
  await sendQueuedMail(f.db,config,sender);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mail_outbox WHERE sent_at IS NULL').get().n,0);
  assert.equal(sent.at(-1).headers['Idempotency-Key'],sent[0].headers['Idempotency-Key']);
  const before=calls;await sendQueuedMail(f.db,config,sender);assert.equal(calls,before);
});
test('чужі бронювання і симуляція платежу недоступні клієнту',async t=>{
  const f=await fixture(t);const b=await f.book();const p=(await f.c.request(`/bookings/${b.id}/checkout`,{})).data.payment;
  const other=f.client();await other.register(2);
  assert.equal((await other.request(`/bookings/${b.id}`)).status,404);
  assert.equal((await other.request(`/payments/${p.id}/simulate`,{outcome:'success'})).status,404);
  assert.equal((await other.request('/bookings')).data.length,0);
});
test('скасування і повне повернення обліковуються окремо, повтор заборонено',async t=>{
  const f=await fixture(t);const b=await f.book();const id=await f.pay(b.id);
  await f.c.request(`/bookings/${b.id}/cancel`,{reason:'Зміна планів'});
  assert.equal(f.db.prepare('SELECT status FROM bookings WHERE id=?').get(b.id).status,'confirmed');
  const admin=f.client();await admin.admin();
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'approve_cancel'})).status,200);
  assert.equal(f.db.prepare('SELECT status FROM payments WHERE id=?').get(id).status,'refund_required');
  assert.equal((await admin.request(`/admin/payments/${id}/refund`,{})).status,200);
  assert.equal((await admin.request(`/admin/payments/${id}/refund`,{})).status,409);
  const r=(await admin.request('/admin/report?start=2026-10-01&end=2026-11-01')).data;
  assert.equal(r.received,540000);assert.equal(r.refunded,540000);assert.equal(r.net,0);
});
test('заселення лише у свій період і виїзд лише після заселення',async t=>{
  const f=await fixture(t);const b=await f.book();await f.pay(b.id);const admin=f.client();await admin.admin();
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'check_in'})).status,400);
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'check_out'})).status,409);
  // Оновлюємо сесію після стрибка годинника більше ніж на 24 години.
  f.clock.now=Date.UTC(2026,10,3,10);await admin.admin();
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'check_in'})).status,200);
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'check_out'})).status,400);
  f.clock.now=Date.UTC(2026,10,6,10);await admin.admin();
  assert.equal((await admin.request(`/admin/bookings/${b.id}/action`,{action:'check_out'})).status,200);
});
test('пошук враховує доступність, категорію, ціну й місткість',async t=>{
  const f=await fixture(t);await f.book();
  const r=await f.c.request('/rooms?start=2026-11-03&end=2026-11-06&guests=2&category=standard&maxPrice=2000');
  assert.deepEqual(r.data.map(r=>r.id),[2]);
});
test('редагування номера, дублі позначень, закриття для нових бронювань',async t=>{
  const f=await fixture(t),admin=f.client();await admin.admin();
  const room=(await admin.request('/admin/rooms')).data[0];
  const body={...room,price:1800,active:false};
  assert.equal((await admin.request('/admin/rooms/'+room.id,body,'PUT')).status,200);
  assert.equal((await f.c.request('/bookings',f.booking)).status,404);
  assert.equal((await admin.request('/admin/rooms',{...body,active:true})).status,409);
});
test('LiqPay: підпис, сума, повторний callback і відсутність підтвердження через redirect',async t=>{
  const f=await fixture(t,{paymentMode:'liqpay',publicKey:'sandbox_public',privateKey:'sandbox_private',baseUrl:'https://hotel.test'});
  const b=await f.book();const checkout=(await f.c.request(`/bookings/${b.id}/checkout`,{})).data;
  assert.equal(checkout.mode,'liqpay');assert.equal(checkout.signature,sign(checkout.data,'sandbox_private'));
  assert.equal((await f.c.request(`/bookings/${b.id}`)).data.status,'pending');
  async function callback(payload,bad=false){const data=pack(payload,f.config);if(bad)data.signature='forged';const r=await fetch(f.baseUrl+'/api/payments/liqpay/callback',{method:'POST',body:new URLSearchParams(data)});return r.status;}
  const event={order_id:checkout.payment.id,payment_id:'123',status:'success',amount:'5400.00',currency:'UAH'};
  assert.equal(await callback(event,true),403);assert.equal(await callback({...event,amount:1}),400);
  assert.equal(await callback(event),200);assert.equal(await callback(event),200);
  assert.equal((await f.c.request(`/bookings/${b.id}`)).data.status,'confirmed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payment_events').get().n,1);
  assert.equal((await f.c.request(`/payments/${checkout.payment.id}/simulate`,{outcome:'success'})).status,404);
});
test('LiqPay SHA3-256 відповідає опублікованому контрольному прикладу API 7',()=>{
  const data='eyJwdWJsaWNfa2V5IjoiaTAwMDAwMDAwIiwidmVyc2lvbiI6NywiYWN0aW9uIjoicGF5IiwiYW1vdW50IjoiMyIsImN1cnJlbmN5IjoiVUFIIiwiZGVzY3JpcHRpb24iOiJ0ZXN0Iiwib3JkZXJfaWQiOiIwMDAwMDEifQ==';
  assert.equal(sign(data,'a4825234f4bae72a0be04eafe9e8e2bada209255'),'0adgJ8F2Ds5HCVkcz4AlmdLMRoIJf7IxsL3QmeFRz/s=');
});
