import json,os,pathlib,subprocess,time,urllib.request,urllib.error,tempfile,shutil
root=pathlib.Path(__file__).resolve().parents[1]
profile=pathlib.Path(tempfile.mkdtemp(prefix='native-smoke-',dir=root/'.kitsune-engine-tests'))
env=os.environ.copy();env['XDG_DATA_HOME']=str(profile);env['TAURI_WEBVIEW_AUTOMATION']='true';env['LD_LIBRARY_PATH']=str(root/'.kitsune-engine-tests/lib/usr/lib')+(':'+env['LD_LIBRARY_PATH'] if env.get('LD_LIBRARY_PATH') else '')
log=open('/tmp/kitsune-native-driver.log','w');process=subprocess.Popen([str(root/'.kitsune-engine-tests/tools/bin/tauri-driver'),'--port','4455','--native-port','4456'],env=env,stdout=log,stderr=log)
sid=None
base='http://127.0.0.1:4455'
def request(method,path,data=None):
 body=None if data is None else json.dumps(data).encode()
 with urllib.request.urlopen(urllib.request.Request(base+path,body,{'Content-Type':'application/json'},method=method),timeout=40) as r:return json.load(r)
def script(js,args=[]):return request('POST','/session/'+sid+'/execute/sync',{'script':js,'args':args})['value']
def asyncscript(js,args=[]):return request('POST','/session/'+sid+'/execute/async',{'script':js,'args':args})['value']
try:
 for _ in range(50):
  try:request('GET','/status');break
  except Exception:time.sleep(.1)
 session=request('POST','/session',{'capabilities':{'alwaysMatch':{'tauri:options':{'application':str(root/'src-tauri/target/debug/kitsune')}}}})
 sid=session['value']['sessionId'];request('POST','/session/'+sid+'/timeouts',{'script':30000})
 for _ in range(80):
  if script('return document.body.innerText.includes("Kitsune") && document.querySelector(".sidebar") !== null'):break
  time.sleep(.2)
 assert script('return !!window.__TAURI_INTERNALS__'), 'Native IPC is unavailable'
 summary=[]
 for driver,port,user,password,db,schema in [('postgres',55432,'kitsune_test','kitsune_test','kitsune_test','public'),('mysql',53306,'kitsune_test','kitsune_test','kitsune_test','kitsune_test'),('mysql',53307,'kitsune_test','kitsune_test','kitsune_test','kitsune_test'),('mssql',51433,'kitsune_test','Kitsune_fixture_rw_42!','kitsune_test','dbo')]:
  config={'id':'native-'+str(port),'name':'Native fixture '+str(port),'driver':driver,'environment':'development','host':'127.0.0.1','port':port,'database':db,'username':user,'password':password,'sslMode':'disable' if driver=='postgres' else 'require','readOnly':False}
  result=asyncscript('''const [config,schema,done]=arguments;
    (async()=>{const {api}=await import('/src/lib/api.ts');await api('connect',config);const tables=await api('tables',{connectionId:config.id});const table=tables.find(t=>t.schema===schema&&t.name==='orders');if(!table)throw Error('Orders table missing');const {refreshConnections}=await import('/src/features/Connections.tsx');await refreshConnections();const {openTab,update}=await import('/src/lib/store.ts');update({activeConnection:config.id});openTab({kind:'table',title:'orders',connectionId:config.id,table});done({ok:true,tableCount:tables.length});})().catch(e=>done({ok:false,error:String(e.message||e)}));''',[config,schema])
  assert result.get('ok'),str(result)
  for _ in range(60):
   if script('return Array.from(document.querySelectorAll("[role=gridcell]")).filter(e=>e.getClientRects().length).length > 0'):break
   time.sleep(.1)
  assert script('return Array.from(document.querySelectorAll("[role=gridcell]")).filter(e=>e.getClientRects().length).length > 0'), 'Native data grid did not render'
  summary.append({'engine':'mariadb' if port==53307 else driver,'port':port,'tables':result['tableCount'],'gridCells':script('return Array.from(document.querySelectorAll("[role=gridcell]")).filter(e=>e.getClientRects().length).length')})
 result=asyncscript('''const done=arguments[0];(async()=>{const {openTab}=await import('/src/lib/store.ts');openTab({kind:'query',title:'Native editor smoke',connectionId:'native-51433',sql:'SELECT id, status FROM dbo.orders ORDER BY id'});done(true)})().catch(e=>done(false));''')
 time.sleep(.6)
 assert script('return !!document.querySelector(".cm-editor")'), 'SQL editor missing'
 script('Array.from(document.querySelectorAll(".query-toolbar button")).find(b=>b.textContent.includes("Run query")).click(); return true;')
 for _ in range(60):
  if script('return Array.from(document.querySelectorAll("[role=gridcell]")).filter(e=>e.getClientRects().length).length === 2'):break
  time.sleep(.1)
 assert script('return Array.from(document.querySelectorAll("[role=gridcell]")).filter(e=>e.getClientRects().length).some(e=>e.textContent.includes("5821"))'), 'Native SQL query results missing'
 print(json.dumps({'nativeWebKit':True,'engines':summary,'sqlEditor':True,'sqlServerQueryExecuted':True}))
finally:
 if sid:
  try:request('DELETE','/session/'+sid)
  except Exception:pass
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill();process.wait()
 log.close()
 shutil.rmtree(profile,ignore_errors=True)
