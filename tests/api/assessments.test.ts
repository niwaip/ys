import {afterEach,expect,test} from 'vitest';
import request from 'supertest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../apps/api/src/app';
let app:Awaited<ReturnType<typeof createApp>>,directory:string;
const auth={Authorization:'Bearer test-assessment-secret'};
const cfg={customers:[{id:'acme',name:'A'},{id:'river',name:'R'}],operators:[{token:'test-assessment-secret',name:'Tester',customerIds:['acme','river']}]};
afterEach(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});});
async function seed(){const http=request(app.getHttpServer());const software=(await http.post('/api/customers/acme/software').set(auth).send({name:'Bill'}).expect(201)).body;const snapshot=(await http.post(`/api/customers/acme/software/${software.id}/sbom`).set(auth).send({fileName:'bill.json',content:JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.5',metadata:{component:{type:'application',name:'Bill',version:'1'}},components:[{type:'library',name:'express',version:'4.18.0',purl:'pkg:npm/express@4.18.0'}]})}).expect(201)).body;return {softwareId:software.id,versionId:snapshot.id};}
async function done(id:string){for(let n=0;n<100;n++){const r=await request(app.getHttpServer()).get(`/api/customers/acme/assessments/${id}`).set(auth).expect(200);if(!['queued','running'].includes(r.body.status))return r.body;await new Promise(r=>setTimeout(r,20));}throw Error('task did not settle');}
test('页面业务接口提交后台软件评估并保留输入、漏洞与执行证据',async()=>{
 directory=await mkdtemp(join(tmpdir(),'ys-assessment-'));const options={...cfg,databaseUrl:`pglite://${directory}`};
 app=await createApp(options,[],{trivyExecutor:{execute:async()=>({status:'succeeded',toolVersion:'fixture-0.69.0',exitCode:0,signal:null,stderr:'fixture only',argv:['sbom','--format','json'],startedAt:'2026-11-18T01:00:00Z',finishedAt:'2026-11-18T01:00:01Z',databaseBefore:{Version:2,UpdatedAt:'2026-11-17T00:00:00Z',NextUpdate:'2026-12-01T00:00:00Z'},databaseAfter:{Version:2,UpdatedAt:'2026-11-17T00:00:00Z',NextUpdate:'2026-12-01T00:00:00Z'},rawReport:JSON.stringify({SchemaVersion:2,ArtifactType:'cyclonedx',Results:[{Target:'bill',Class:'lang-pkgs',Type:'npm',Packages:[{Name:'express',Version:'4.18.0',Identifier:{PURL:'pkg:npm/express@4.18.0'}}],Vulnerabilities:[{VulnerabilityID:'CVE-2024-TEST',PkgName:'express',InstalledVersion:'4.18.0',FixedVersion:'4.19.2',Severity:'HIGH',PrimaryURL:'https://example.test/advisory',PkgIdentifier:{PURL:'pkg:npm/express@4.18.0'},Status:'fixed',DataSource:{Name:'fixture'}}]}]})})}});
 const target=await seed();const http=request(app.getHttpServer());const submitted=await http.post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'request-1'}).expect(202);expect(submitted.body).toMatchObject({status:'queued',target:{kind:'software',...target}});
 const result=await done(submitted.body.id);expect(result).toMatchObject({status:'succeeded',result:{outcome:'findings',coverage:{status:'complete_for_declared_input'},findings:[{vulnerabilityId:'CVE-2024-TEST',packageName:'express',installedVersion:'4.18.0',fixedVersion:'4.19.2',severity:'HIGH',applicability:'tool_reported'}]}});expect(result.input.contentHash).toMatch(/^[a-f0-9]{64}$/);expect(result.execution.toolVersion).toBe('fixture-0.69.0');expect(result.execution.rawReport).toContain('CVE-2024-TEST');
 const replay=await http.post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'request-1'}).expect(202);expect(replay.body.id).toBe(result.id);expect(replay.body.replayed).toBe(true);
 await app.close();app=await createApp(options);const persisted=await request(app.getHttpServer()).get(`/api/customers/acme/assessments/${result.id}`).set(auth).expect(200);expect(persisted.body.result.findings).toHaveLength(1);
 await request(app.getHttpServer()).get(`/api/customers/river/assessments/${result.id}`).set(auth).expect(404);
 await request(app.getHttpServer()).post('/api/customers/river/assessments').set(auth).send({...target,idempotencyKey:'request-1'}).expect(404);
});
const execution=(rawReport:string)=>({status:'succeeded' as const,toolVersion:'fixture-version',argv:['sbom'],startedAt:'2026-11-18T01:00:00Z',finishedAt:'2026-11-18T01:00:01Z',exitCode:0,signal:null,stderr:'',databaseBefore:{UpdatedAt:'2020-01-01T00:00:00Z',NextUpdate:'2020-01-02T00:00:00Z'},databaseAfter:{UpdatedAt:'2020-01-01T00:00:00Z',NextUpdate:'2020-01-02T00:00:00Z'},rawReport});
test('工具包身份与安装版本矛盾不能将发现或覆盖关联到输入组件',async()=>{
 directory=await mkdtemp(join(tmpdir(),'ys-assessment-identity-'));app=await createApp({...cfg,databaseUrl:`pglite://${directory}`},[],{trivyExecutor:{execute:async()=>execution(JSON.stringify({SchemaVersion:2,Results:[{Target:'bill',Type:'npm',Packages:[{Name:'express',Version:'999',Identifier:{PURL:'pkg:npm/express@4.18.0'}}],Vulnerabilities:[{VulnerabilityID:'CVE-TEST',PkgName:'express',InstalledVersion:'999',Severity:'HIGH',PkgIdentifier:{PURL:'pkg:npm/express@4.18.0'}}]}]}))}});
 const target=await seed();const r=await request(app.getHttpServer()).post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'contradiction'}).expect(202);const job=await done(r.body.id);expect(job.result.coverage.status).toBe('partial');expect(job.result.findings[0].componentId).toBeNull();expect(job.result.database.freshness).toBe('stale');
});
test('零发现、未知覆盖、异常报告和未配置工具保持不同状态及历史',async()=>{
 directory=await mkdtemp(join(tmpdir(),'ys-assessment-outcomes-'));const options={...cfg,databaseUrl:`pglite://${directory}`};const reports=[JSON.stringify({SchemaVersion:2,Results:[{Target:'bill',Type:'npm',Packages:[{Name:'express',Version:'4.18.0',Identifier:{PURL:'pkg:npm/express@4.18.0'}}],Vulnerabilities:[]}]}),JSON.stringify({SchemaVersion:2,Results:[]}),'{broken'];
 app=await createApp(options,[],{trivyExecutor:{execute:async()=>execution(reports.shift()!)}});const target=await seed();
 const submit=async(key:string)=>(await request(app.getHttpServer()).post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:key}).expect(202)).body;
 const clean=await done((await submit('clean')).id);expect(clean.status).toBe('succeeded');expect(clean.result).toMatchObject({outcome:'no_findings',coverage:{status:'complete_for_declared_input'},database:{freshness:'stale'}});
 const unknown=await done((await submit('unknown')).id);expect(unknown.result).toMatchObject({outcome:'no_findings',coverage:{status:'unknown'}});
 const broken=await done((await submit('broken')).id);expect(broken.status).toBe('failed');expect(broken.result).toBeUndefined();expect(broken.execution.rawReport).toBe('{broken');
 await app.close();app=await createApp(options);const unavailable=await done((await submit('unavailable')).id);expect(unavailable.status).toBe('unavailable');expect(unavailable.result).toBeUndefined();
 const history=await request(app.getHttpServer()).get('/api/customers/acme/assessments').set(auth).expect(200);expect(history.body.items).toHaveLength(4);expect(history.body.items.find((j:any)=>j.id===broken.id).execution).toBeUndefined();expect(history.body).toMatchObject({total:4,limit:50,offset:0});
 const other=(await request(app.getHttpServer()).post('/api/customers/acme/software').set(auth).send({name:'Other'}).expect(201)).body;await request(app.getHttpServer()).post('/api/customers/acme/assessments').set(auth).send({softwareId:other.id,versionId:target.versionId,idempotencyKey:'clean'}).expect(404);
});
test('后台关闭会中断执行并在重启后恢复等待任务，终态幂等键不自动重扫',async()=>{
 directory=await mkdtemp(join(tmpdir(),'ys-assessment-restart-'));const options={...cfg,databaseUrl:`pglite://${directory}`};
 app=await createApp(options,[],{trivyExecutor:{execute:async(_,signal)=>new Promise(resolve=>{const finish=()=>resolve({...execution(''),status:'interrupted',error:'fixture aborted'});if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});})}});const target=await seed();const http=request(app.getHttpServer());const first=(await http.post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'running'}).expect(202)).body;
 for(let n=0;n<100;n++){const r=await http.get(`/api/customers/acme/assessments/${first.id}`).set(auth);if(r.body.status==='running')break;await new Promise(r=>setTimeout(r,10));}
 const second=(await http.post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'waiting'}).expect(202)).body;await app.close();app=await createApp(options);
 const stopped=await done(first.id);expect(stopped.status).toBe('interrupted');expect((await done(second.id)).status).toBe('unavailable');const replay=await request(app.getHttpServer()).post('/api/customers/acme/assessments').set(auth).send({...target,idempotencyKey:'running'}).expect(202);expect(replay.body).toMatchObject({id:first.id,status:'interrupted',replayed:true});
});
