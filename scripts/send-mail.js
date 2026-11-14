import { configuration } from '../src/config.js';
import { openDatabase } from '../src/database.js';
import { sendQueuedMail } from '../src/mail.js';
const config=configuration({seed:false});
if(!config.mailKey||!config.mailFrom){
  console.log('Надсилання не налаштовано. Заповніть RESEND_API_KEY і MAIL_FROM у .env. Листи залишаються в черзі.');
}else{
  const db=openDatabase(config);
  try{const result=await sendQueuedMail(db,config);console.log(`Надіслано листів: ${result.sent}. Помилки доступні в адмінпанелі.`);}finally{db.close();}
}
