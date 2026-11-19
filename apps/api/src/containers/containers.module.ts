import {BadRequestException,ConflictException,Controller,Get,Inject,Module,NotFoundException,Post,Req} from '@nestjs/common';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {DATABASE,type Database,type Queryable} from '../persistence/database';
import type {AuthorizedRequest} from '../auth/auth';
import type {ContainerImage,ContainerVersion} from '../../../../packages/contracts/containers';
import {parseCycloneDx} from '../software/cyclonedx';
import {parseImageIdentity} from './identity';
const inputSchema=z.object({fileName:z.string().trim().min(1).max(200),content:z.string().min(1).max(500000),repository:z.string().trim().min(1).max(500).optional(),digest:z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),tag:z.string().trim().min(1).max(200).optional(),architecture:z.string().trim().min(1).max(100).optional()}).strict();
const cols=`id,customer_id AS "customerId",name,source,created_at AS "createdAt"`;
const versionCols=`id,customer_id AS "customerId",container_id AS "containerId",import_id AS "importId",version,details,created_at AS "createdAt"`;
function image(row:Record<string,unknown>):ContainerImage{return {...row,kind:'container',createdAt:new Date(row.createdAt as string).toISOString()} as ContainerImage;}
function version(row:Record<string,unknown>):ContainerVersion{const {details,...base}=row;return {...base,...details as object,createdAt:new Date(row.createdAt as string).toISOString()} as ContainerVersion;}
export class ContainerService{
 constructor(private readonly db:Database){}
 async create(customer:string,name:string,source:string){const r=await this.db.query(`INSERT INTO container_images(id,customer_id,name,source) VALUES($1,$2,$3,$4) RETURNING ${cols}`,[randomUUID(),customer,name,source]);return image(r.rows[0]);}
 async list(customer:string){const r=await this.db.query(`SELECT ${cols} FROM container_images WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100`,[customer]);return {items:r.rows.map(image)};}
 async get(customer:string,id:string,session:Queryable=this.db){const r=await session.query(`SELECT ${cols} FROM container_images WHERE customer_id=$1 AND id=$2`,[customer,id]);if(!r.rows.length)throw new NotFoundException('该客户下未找到容器镜像');const v=await session.query(`SELECT ${versionCols} FROM container_versions WHERE customer_id=$1 AND container_id=$2 ORDER BY created_at DESC,id`,[customer,id]);return {...image(r.rows[0]),versions:v.rows.map(version)};}
 async getVersion(customer:string,containerId:string,id:string,session:Queryable=this.db){const r=await session.query(`SELECT ${versionCols} FROM container_versions WHERE customer_id=$1 AND container_id=$2 AND id=$3`,[customer,containerId,id]);if(!r.rows.length)throw new NotFoundException('该客户镜像下未找到输入版本');return version(r.rows[0]);}
 async upload(customer:string,containerId:string,input:z.infer<typeof inputSchema>){
 const parsed=parseCycloneDx(input.content);const {fileName,content,...claim}=input;const identity=parseImageIdentity(content,claim);const hash=createHash('sha256').update(content).digest('hex');
 return this.db.transaction(async session=>{await this.get(customer,containerId,session);const existing=await session.query(`SELECT id,result FROM import_materials WHERE customer_id=$1 AND format='container-cyclonedx-json' AND content_hash=$2`,[customer,hash]);
 if(existing.rows.length){const old=existing.rows[0].result as {containerId:string;versionId:string;claim:object};if(old.containerId!==containerId||(['repository','digest','tag','architecture'] as const).some(key=>(old.claim as Record<string,unknown>)[key]!==claim[key]))throw new ConflictException('相同容器资料已绑定其他镜像或身份声明；不覆盖原来源');return {...await this.getVersion(customer,containerId,old.versionId,session),replayed:true};}
 const id=randomUUID(),importId=randomUUID();const result={containerId,versionId:id,claim,status:'committed',committedAt:new Date().toISOString(),policy:'atomic',canCommit:false,mapping:{components:'containerVersion.components'},rows:parsed.components.map((c,i)=>({row:i+1,status:'imported',componentId:c.id,issues:c.issues}))};
 const saved=await session.query(`INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'container-cyclonedx-json',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[importId,customer,fileName,content,hash,JSON.stringify(result)]);if(!saved.rows.length)throw new ConflictException('资料并发接入，请重试读取原版本');
 const details={identity:identity.identity,collectedAt:parsed.collectedAt,components:parsed.components,issues:identity.issues,operatingSystems:parsed.components.filter(c=>c.raw.type==='operating-system').map(c=>({componentId:c.id,name:c.name,version:c.version,cpe:c.cpe}))};
 const r=await session.query(`INSERT INTO container_versions(id,customer_id,container_id,import_id,version,details) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING ${versionCols}`,[id,customer,containerId,importId,identity.identity.digest,JSON.stringify(details)]);return {...version(r.rows[0]),replayed:false};});
 }
}
@Controller('api/customers/:customerId/containers')class ContainersController{
 constructor(private readonly containers:ContainerService){}
 @Post() create(req:AuthorizedRequest){const input=z.object({name:z.string().trim().min(1).max(200),source:z.string().trim().min(1).max(200)}).strict().safeParse(req.body);if(!input.success)throw new BadRequestException('镜像名称与来源必填，最多200字符');return this.containers.create(req.params.customerId,input.data.name,input.data.source);}
 @Get() list(req:AuthorizedRequest){return this.containers.list(req.params.customerId);}
 @Get(':containerId') get(req:AuthorizedRequest){this.valid(req);return this.containers.get(req.params.customerId,req.params.containerId);}
 @Get(':containerId/versions/:versionId') getVersion(req:AuthorizedRequest){this.valid(req);if(!z.uuid().safeParse(req.params.versionId).success)throw new BadRequestException('镜像输入版本编号无效');return this.containers.getVersion(req.params.customerId,req.params.containerId,req.params.versionId);}
 @Post(':containerId/sbom') upload(req:AuthorizedRequest){this.valid(req);const input=inputSchema.safeParse(req.body);if(!input.success)throw new BadRequestException('容器SBOM输入或镜像身份无效；digest需完整小写sha256');return this.containers.upload(req.params.customerId,req.params.containerId,input.data);}
 private valid(req:AuthorizedRequest){if(!z.uuid().safeParse(req.params.containerId).success)throw new BadRequestException('镜像编号无效');}
}
for(const method of ['create','list','get','getVersion','upload'] as const)Req()(ContainersController.prototype,method,0);Inject(ContainerService)(ContainersController,undefined,0);
@Module({controllers:[ContainersController],providers:[{provide:ContainerService,inject:[DATABASE],useFactory:(db:Database)=>new ContainerService(db)}],exports:[ContainerService]})export class ContainersModule{}
