// Isolated disposable app for manual browser regression checks. Never loads PG.
const { startIsolatedTestApp, TEST_PASSWORD } = require('../tests/e2e/test-app.cjs');
(async()=>{
  const app=await startIsolatedTestApp();
  const login=await fetch(app.baseUrl+'/api/test-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:'bojan',password:TEST_PASSWORD})});
  const data=await login.json();
  const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrfToken};
  for(const title of ['QA Alfa','QA Beta','QA Gama','QA Delta']) await fetch(app.baseUrl+'/api/todos',{method:'POST',headers,body:JSON.stringify({title,client:'Testna stranka',status:'open',syncUser:'bojan',assigneeIds:['bojan']})});
  console.log(app.baseUrl);
  const stop=async()=>{await app.stop();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  setInterval(()=>{},60000);
})().catch(error=>{console.error(error);process.exit(1);});
