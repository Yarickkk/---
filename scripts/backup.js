// SQLite Backup API створює узгоджену копію навіть під час роботи сервера.
import { backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { configuration } from '../src/config.js';
import { openDatabase } from '../src/database.js';
const config=configuration({seed:false}),db=openDatabase(config);
const dir=path.join(config.dataDir,'backups');mkdirSync(dir,{recursive:true});
const target=path.join(dir,`hotel-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
try{await backup(db,target);console.log(`Резервна копія: ${target}`);}finally{db.close();}
