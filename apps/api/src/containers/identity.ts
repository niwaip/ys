import {BadRequestException} from '@nestjs/common';
import type {ImageIdentity} from '../../../../packages/contracts/containers';
export type IdentityClaim={repository?:string;digest?:string;tag?:string;architecture?:string};
const digestPattern=/^sha256:[0-9a-f]{64}$/;
export function parseImageIdentity(content:string,claim:IdentityClaim){
 const json=JSON.parse(content.replace(/^\uFEFF/,''));const root=json.metadata?.component;
 if(root?.type!=='container')throw new BadRequestException('容器 SBOM 需 metadata.component.type=container；软件输入请走软件入口');
 let repository:string|null=null,digest:string|null=null,tag:string|null=null,architecture:string|null=null;const purl=typeof root.purl==='string'?root.purl:null;
 if(purl){const match=purl.match(/^pkg:oci\/([^/@?#]+)(?:@([^?#]+))?(?:\?([^#]*))?(?:#.*)?$/);if(!match)throw new BadRequestException('容器根 PURL 仅支持 pkg:oci，需符合 OCI 身份结构');try{const params=new URLSearchParams(match[3]??'');for(const key of ['repository_url','tag','arch'])if(params.getAll(key).length>1)throw Error('重复身份限定符');digest=match[2]?decodeURIComponent(match[2]):null;if(digest&&!digestPattern.test(digest))throw Error('OCI version 必须是完整 sha256 digest');repository=params.get('repository_url');tag=params.get('tag');architecture=params.get('arch');}catch{throw new BadRequestException('OCI PURL digest/编码/身份限定符无效');}}
 const extracted={repository,digest,tag,architecture};for(const key of ['repository','digest','tag','architecture'] as const){if(claim[key]&&extracted[key]&&claim[key]!==extracted[key])throw new BadRequestException(`声明的 ${key} 与 SBOM 镜像身份矛盾`);}
 const identity:ImageIdentity={repository:claim.repository??repository,digest:claim.digest??digest,tag:claim.tag??tag,architecture:claim.architecture??architecture,purl,basis:Object.values(claim).some(Boolean)?'operator':purl?'sbom-oci-purl':'unknown'};
 const issues:string[]=[];if(!identity.digest)issues.push('镜像 digest 未知；标签可变，无法确认不可变镜像身份');if(!identity.repository)issues.push('镜像仓库来源未知');if(!identity.architecture)issues.push('镜像架构未知，无法确认多架构镜像范围');issues.push('镜像资料来自上传声明，未连接仓库核实；不代表任何运行实例采用该镜像');
 return {identity,issues};
}
