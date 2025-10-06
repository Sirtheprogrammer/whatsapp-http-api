import db from '../db.js';

const id = '408f7372-f7c9-4299-a8db-326bc5548a73';

async function main(){
  try{
    await db.init();
    const s = await db.loadSession(id);
    console.log('DB session for', id, ':');
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
  }catch(err){
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
