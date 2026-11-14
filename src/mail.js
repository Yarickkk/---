import { createHash } from 'node:crypto';

/** Окремий модуль доставки: помилка email не відкочує успішну оплату.
 * API: https://resend.com/docs/api-reference/emails/send-email
 */
export async function sendQueuedMail(db, config, send = fetch) {
  if (!config.mailKey || !config.mailFrom) return { sent:0, skipped:true };
  const messages=db.prepare('SELECT * FROM mail_outbox WHERE sent_at IS NULL AND attempts<5 ORDER BY id LIMIT 30').all();
  let sent=0;
  for(const mail of messages) {
    try {
      // Стабільний ключ допомагає сервісу розпізнати повтор після мережевого збою.
      const key=createHash('sha256').update(`${mail.id}:${mail.created_at}:${mail.recipient}:${mail.body}`).digest('hex');
      const response=await send('https://api.resend.com/emails',{
        method:'POST',signal:AbortSignal.timeout(15000),
        headers:{Authorization:`Bearer ${config.mailKey}`,'Content-Type':'application/json','Idempotency-Key':key},
        body:JSON.stringify({from:config.mailFrom,to:[mail.recipient],subject:mail.subject,text:mail.body}),
      });
      if(!response.ok)throw Error(`Поштовий сервіс повернув HTTP ${response.status}.`);
      db.prepare("UPDATE mail_outbox SET sent_at=?,attempts=attempts+1,error='' WHERE id=?").run(config.now(),mail.id);sent++;
    }catch(error){db.prepare('UPDATE mail_outbox SET attempts=attempts+1,error=? WHERE id=?').run(error.message.slice(0,400),mail.id);}
  }
  return {sent,skipped:false};
}
