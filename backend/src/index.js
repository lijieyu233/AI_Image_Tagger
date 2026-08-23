import { ensureDirs } from './config.js';
import { getDb, syncVocab } from './db.js';
import { startServer } from './server.js';

ensureDirs();
getDb();
syncVocab();
startServer();
