import type { ImportMaterial } from './index';
export type Software = {id:string;customerId:string;name:string;kind:'software';createdAt:string};
export type SoftwareComponent = {id:string;name:string;version:string|null;ecosystem:string|null;purl:string|null;cpe:string|null;bomRef:string|null;parentRef:string|null;issues:string[];raw:Record<string,unknown>};
export type SoftwareVersion = {id:string;customerId:string;softwareId:string;version:string|null;importId:string;createdAt:string;collectedAt:string|null;components:SoftwareComponent[];issues:string[];replayed?:boolean};
export type SoftwareDetail = Software & {versions:SoftwareVersion[]};
export type SbomMaterial = Omit<ImportMaterial,'format'> & {format:'cyclonedx-json'};
