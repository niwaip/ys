import type {SoftwareComponent} from './software';
export type ContainerImage={id:string;customerId:string;kind:'container';name:string;source:string;createdAt:string};
export type ImageIdentity={repository:string|null;digest:string|null;tag:string|null;architecture:string|null;purl:string|null;basis:'sbom-oci-purl'|'operator'|'unknown';};
export type ContainerVersion={id:string;customerId:string;containerId:string;importId:string;version:string|null;createdAt:string;collectedAt:string|null;identity:ImageIdentity;issues:string[];components:SoftwareComponent[];operatingSystems:{componentId:string;name:string;version:string|null;cpe:string|null}[];replayed?:boolean;};
export type ContainerDetail=ContainerImage & {versions:ContainerVersion[]};
