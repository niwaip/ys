/** A downloaded program only; the server never executes user-selected paths. */
export function downloadSoftwareComponentScript(path: string, assetId: string) {
  if (!path.trim()) throw new Error("请填写明确的应用组件目录");
  const content = `import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, parse } from 'node:path';
// Declared target asset: ${assetId}
const target = resolve(${JSON.stringify(path)});
if (target === parse(target).root || !statSync(target).isDirectory()) throw new Error('Choose a specific application directory, not a filesystem root');
const result = spawnSync('trivy', ['fs', '--format', 'cyclonedx', '--output', 'software-sbom.json', target], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Generated software-sbom.json for the declared application path. Upload and explicitly associate it with the host; this does not run a vulnerability assessment.');
`;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/javascript" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "ys-software-sbom.mjs";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
