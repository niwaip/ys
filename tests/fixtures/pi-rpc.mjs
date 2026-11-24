// Isolated RPC process fixture. Never contacts Pi providers or public sources.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
const request=JSON.parse(await readFile(process.env.YS_AGENT_REQUEST_FILE,'utf8'));
const output=o=>process.stdout.write(JSON.stringify(o)+'\n');
createInterface({input:process.stdin}).on('line',async line=>{const cmd=JSON.parse(line);output({type:'response',id:cmd.id,command:'prompt',success:true});if(request.original.includes('timeout'))return;
 const result={schema_version:'2.2',status:'partial',query:{original:request.original,product:'php',product_scope:'runtime',as_of:'2026-11-18T00:00:00Z',timezone:'Asia/Shanghai'},coverage:{status:'partial',displayed:1,limitations:['固定样例：第二来源不可用'],has_more:'unknown'},sources:[{source_id:'php',url:'https://www.php.net/',fetched_at:'2026-11-18T00:00:00Z',status:'ok',cache_hit:false}],agent_view:{scope:'PHP runtime',summary:'固定样例：本次取得来源中有一条',results:[{cve_id:'CVE-2024-4577',title:'固定样例',source_ids:['php']}],sources:[]},target_assessment:'not_assessed',target_verification:'not_executed'};
 await mkdir(request.outputDir,{recursive:true});await writeFile(join(request.outputDir,'result.json'),JSON.stringify(result));await writeFile(join(request.outputDir,'report.html'),'<html>Fixed fixture</html>');
 output({type:'tool_execution_start',toolCallId:'1',toolName:'ys_public_cve_query',args:{}});output({type:'tool_execution_end',toolCallId:'1',toolName:'ys_public_cve_query',isError:false,result:{content:[{type:'text',text:'tool completed'}]}});
 output({type:'agent_end'});setTimeout(()=>output({type:'agent_settled'}),80);
});
