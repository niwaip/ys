import { spawn } from "node:child_process";
const prelude = String.raw`export LC_ALL=C
PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
YS_DOCKER_CONFIG=$(mktemp -d) || exit 1
trap 'rm -rf "$YS_DOCKER_CONFIG"' EXIT HUP INT TERM
DOCKER_CONFIG=$YS_DOCKER_CONFIG
export DOCKER_CONFIG
emit() {
 key=$1
 shift
 value=$("$@" 2>&1)
 code=$?
 printf '%s|%s|' "$key" "$code"
 printf '%s' "$value" | base64 | tr -d '\n'
 printf '\n'
}
emit hostname uname -n
emit machineId cat /etc/machine-id
emit serial cat /sys/class/dmi/id/product_serial
`;
const basic = String.raw`emit os cat /etc/os-release
emit dpkgStatus cat /var/lib/dpkg/status
emit lsbRelease cat /etc/lsb-release
emit debianVersion cat /etc/debian_version
emit kernel uname -r
emit architecture uname -m
emit virtualization systemd-detect-virt --vm
emit xenNetback sh -c 'test -d /sys/module || exit 127; if test -d /sys/module/xen_netback; then printf true; else printf false; fi'
emit listeningPorts ss -H -lntu
emit packages sh -c 'if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f="dpkg\t\${Package}\t\${Version}\t\${Architecture}\t\${db:Status-Status}\n"; elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf "rpm\t%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\tinstalled\n"; else exit 127; fi'
emit cpu cat /proc/cpuinfo
emit memory cat /proc/meminfo
emit disks df -P
emit network ip -j address
emit dockerClient docker --version
`;
const daemon = String.raw`emit dockerDaemon docker --host unix:///var/run/docker.sock version --format '{{json .Server}}'
`;
const inventory = String.raw`emit containers sh -c 'ids=$(docker --host unix:///var/run/docker.sock ps -aq --no-trunc) || exit $?; for id in $ids; do case "$id" in ""|*[!0-9a-f]*) exit 1;; esac; docker --host unix:///var/run/docker.sock inspect --type container --format '\''{"containerId":{{json .Id}},"imageId":{{json .Image}},"name":{{json .Name}},"state":{{json .State.Status}}}'\'' "$id" || exit $?; done'
emit images docker --host unix:///var/run/docker.sock image ls --no-trunc --digests --format '{{json .}}'
`;
function collectionError(code, message) {
  return Object.assign(new Error(message), { code });
}
export function execute(profile, script, signal, maxBytes = 8000000) {
  return new Promise((resolve, reject) => {
    const args = [
      "-F",
      "/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${profile.knownHostsFile}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-i",
      profile.identityFile,
      "-p",
      String(profile.port ?? 22),
      "-l",
      profile.username,
      "--",
      profile.host,
      "sh -s",
    ];
    const local = profile.transport === "local";
    const child = spawn(
      local ? "/bin/sh" : (profile.sshExecutable ?? "/usr/bin/ssh"),
      local ? ["-s"] : args,
      {
        shell: false,
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = [],
      bytes = 0,
      done = false,
      stderr = "";
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) child.kill("SIGKILL");
      error ? reject(error) : resolve(value);
    };
    const abort = () =>
      finish(collectionError("timed_out", "SSH采集超时或中止，未自动重试"));
    const timer = setTimeout(abort, profile.timeoutMs ?? 60000);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(collectionError("connection_failed", "SSH执行程序或连接不可用")),
    );
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes)
        finish(
          collectionError(
            "output_limit",
            "SSH输出超出8000000字节，未保存截断清单",
          ),
        );
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes)
        finish(collectionError("output_limit", "SSH输出超限"));
      else if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const reason = /host key|identification has changed/i.test(stderr)
          ? "主机身份校验失败"
          : /permission denied/i.test(stderr)
            ? "SSH登录被拒绝"
            : "SSH连接或固定脚本失败";
        const failureCode = /host key|identification has changed/i.test(stderr)
          ? "host_key_failed"
          : /permission denied/i.test(stderr)
            ? "login_failed"
            : "connection_failed";
        finish(
          Object.assign(collectionError(failureCode, reason), {
            exitCode: code,
          }),
        );
      } else finish(undefined, Buffer.concat(out).toString("utf8"));
    });
    child.stdin.end(script);
  });
}
function parse(raw) {
  const values = {};
  for (const line of raw.trimEnd().split("\n")) {
    const fields = line.split("|");
    if (
      fields.length !== 3 ||
      !/^\w+$/.test(fields[0]) ||
      !/^\d+$/.test(fields[1]) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(fields[2]) ||
      values[fields[0]]
    )
      throw new Error("固定采集协议无效");
    const text = Buffer.from(fields[2], "base64").toString("utf8");
    if (text.includes("\uFFFD")) throw new Error("采集输出不是有效UTF-8");
    values[fields[0]] = { code: Number(fields[1]), text };
  }
  return values;
}
function section(value, mapper = (text) => text) {
  if (!value) return { status: "not_collected", data: null, issues: [] };
  if (value.code !== 0)
    return {
      status:
        value.code === 127
          ? "unsupported"
          : value.code === 126 || /permission denied/i.test(value.text)
            ? "permission_denied"
            : "failed",
      data: null,
      issues: ["固定查询未取得资料"],
    };
  try {
    return { status: "acquired", data: mapper(value.text), issues: [] };
  } catch {
    return {
      status: "failed",
      data: null,
      issues: ["固定查询输出格式不兼容，未声明空清单"],
    };
  }
}
export async function collect(profile, scope, signal) {
  if (
    !["basic", "container-inventory"].includes(scope) ||
    (scope === "container-inventory" && !profile.allowDocker)
  )
    throw new Error("连接配置未授权该能力");
  const raw = await execute(
    profile,
    prelude +
      (scope === "basic" ? basic : inventory) +
      (scope === "container-inventory" ? daemon : ""),
    signal,
  );
  const values = parse(raw);
  if (values.hostname?.code !== 0 || !values.hostname.text.trim())
    throw new Error("未取得可校验的主机身份");
  const sections = {};
  const rawSections = {};
  for (const [key, value] of Object.entries(values))
    if (value.code === 0) rawSections[key] = value.text;
  if (scope === "basic") {
    const info = {};
    if (values.os?.code === 0)
      for (const line of values.os.text.split("\n")) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (match) info[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    const osIssues = [];
    if (values.os?.code !== 0)
      osIssues.push(`发行版查询未取得：${section(values.os).status}`);
    if (!info.ID) osIssues.push("发行版ID未知");
    if (!info.VERSION_ID) osIssues.push("发行版版本未知");
    if (values.kernel?.code !== 0 || !values.kernel.text.trim())
      osIssues.push(`运行内核未取得：${section(values.kernel).status}`);
    if (values.architecture?.code !== 0 || !values.architecture.text.trim())
      osIssues.push(`架构未取得：${section(values.architecture).status}`);
    sections.os = {
      status: osIssues.length ? "partial" : "acquired",
      data: {
        id: info.ID ?? null,
        version: info.VERSION_ID ?? null,
        kernel: values.kernel?.code === 0 ? values.kernel.text : null,
        runtime: {
          virtualization: section(values.virtualization, (text) => {
            if (!text.trim()) throw Error("empty");
            return text.trim();
          }),
          xenNetback: section(values.xenNetback, (text) => {
            if (!["true", "false"].includes(text)) throw Error("boolean");
            return text === "true";
          }),
          listeningPorts: section(values.listeningPorts, (text) => {
            if (text.length > 16000) throw Error("limit");
            return text;
          }),
        },
        architecture:
          values.architecture?.code === 0 ? values.architecture.text : null,
      },
      issues: osIssues,
    };
    sections.packages = section(values.packages, (text) =>
      text
        ? text.split("\n").map((line) => {
            const [manager, name, version, architecture, state, ...rest] =
              line.split("\t");
            if (
              !["dpkg", "rpm"].includes(manager) ||
              !name ||
              !version ||
              !architecture ||
              !state ||
              rest.length
            )
              throw new Error("package");
            return {
              manager,
              name,
              version,
              architecture,
              state: ["installed", "config-files", "unpacked"].includes(state)
                ? state
                : "other",
              sourceState: state,
            };
          })
        : [],
    );
    const hardware = {
      cpu: section(values.cpu),
      memory: section(values.memory),
      disks: section(values.disks),
    };
    sections.hardware = {
      status: Object.values(hardware).every((v) => v.status === "acquired")
        ? "acquired"
        : "partial",
      data: hardware,
      issues: [],
    };
    sections.network = section(values.network, JSON.parse);
    sections.dockerClient = section(values.dockerClient, (text) => ({
      version: /Docker version ([^,\s]+)/.exec(text)?.[1] ?? null,
      raw: text,
    }));
  }
  if (scope === "container-inventory")
    sections.dockerDaemon = section(values.dockerDaemon, (text) => {
      const server = JSON.parse(text);
      if (!server?.Version) throw new Error("daemon");
      return { version: server.Version, details: server };
    });
  if (scope === "container-inventory") {
    sections.containers = section(values.containers, (text) =>
      text
        ? text.split("\n").map((line) => {
            const value = JSON.parse(line);
            if (
              !/^[0-9a-f]{64}$/.test(value.containerId) ||
              !/^sha256:[0-9a-f]{64}$/.test(value.imageId)
            )
              throw new Error("identity");
            return value;
          })
        : [],
    );
    sections.images = section(values.images, (text) =>
      text
        ? text.split("\n").map((line) => {
            const row = JSON.parse(line);
            if (!/^sha256:[0-9a-f]{64}$/.test(row.ID)) throw new Error("image");
            return {
              imageId: row.ID,
              repository: row.Repository,
              tag: row.Tag === "<none>" ? null : row.Tag,
              digest: row.Digest === "<none>" ? null : row.Digest,
              digestKind: "unspecified",
            };
          })
        : [],
    );
  }
  return {
    schemaVersion: "ys-host/1",
    identity: {
      hostname: values.hostname.text.trim(),
      serial:
        values.serial?.code === 0 && values.serial.text.trim()
          ? values.serial.text.trim()
          : null,
      machineId:
        values.machineId?.code === 0 && values.machineId.text.trim()
          ? values.machineId.text.trim()
          : null,
    },
    collectedAt: new Date().toISOString(),
    sections,
    extensions: {
      adapterVersion: "linux-ssh/1",
      receivedAt: new Date().toISOString(),
      rawSections,
      coverage: {
        packages:
          "dpkg/rpm installed database, including non-installed dpkg states; manual software and application dependencies not covered",
        containers:
          "inventory only; writable layers, volumes and image components not scanned",
      },
    },
  };
}

// A bounded read-only check; it does not discover images or generate SBOMs.
export async function probe(profile, scope, signal) {
  const script =
    prelude +
    `# YS_CAPABILITY_PROBE\nemit identity id -un\nemit basic sh -c 'test -r /etc/os-release && uname -s'\n` +
    (scope === "container-inventory" && profile.allowDocker
      ? `emit dockerClient docker --version\n${daemon}emit trivy sh -c 'command -v trivy >/dev/null 2>&1 || exit 127; trivy --version'\n`
      : "");
  const values = parse(
    await execute(
      { ...profile, timeoutMs: Math.min(profile.timeoutMs ?? 15000, 15000) },
      script,
      signal,
      100000,
    ),
  );
  if (values.hostname?.code !== 0 || !values.hostname.text.trim())
    throw new Error("identity");
  const check = (value) => ({
    status: !value
      ? "unchecked"
      : value.code === 0
        ? "available"
        : value.code === 127
          ? "tool_missing"
          : "access_failed",
  });
  return {
    hostname: values.hostname.text.trim(),
    identity: values.identity?.code === 0 ? values.identity.text.trim() : null,
    basic: check(values.basic),
    docker:
      scope !== "container-inventory"
        ? { status: "unchecked" }
        : !profile.allowDocker
          ? { status: "unauthorized" }
          : values.dockerClient?.code === 127
            ? { status: "tool_missing" }
            : check(values.dockerDaemon),
    trivy: check(values.trivy),
  };
}
