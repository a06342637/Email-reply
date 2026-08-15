import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  compareReleaseVersions,
  composeVersionEnvironment,
  latestReleaseTag,
  normalizeRepositoryUrl,
  releaseVersionFromTag,
  replaceEnvValue,
  sanitizeUpdaterLog,
} from "./updates/updater-core.js";

type UpdatePhase =
  | "IDLE"
  | "CHECKING"
  | "AVAILABLE"
  | "UP_TO_DATE"
  | "QUEUED"
  | "BACKING_UP"
  | "PREPARING"
  | "BUILDING"
  | "STOPPING"
  | "MIGRATING"
  | "STARTING"
  | "HEALTH_CHECK"
  | "SUCCEEDED"
  | "ROLLED_BACK"
  | "FAILED";

type UpdateState = {
  phase: UpdatePhase;
  busy: boolean;
  progress: number;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string;
  checkedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  currentCommit: string | null;
  targetCommit: string | null;
  releaseNotes: string[];
  blockedReason: string | null;
  backupFile: string | null;
  rollbackImage: string | null;
  error: string | null;
  logs: string[];
  updaterVersion: string;
};

type Discovery = {
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  currentCommit: string;
  targetCommit: string;
  releaseNotes: string[];
  updateAvailable: boolean;
  blockedReason: string | null;
};

class UpdaterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const port = Number.parseInt(process.env.UPDATE_PORT ?? "3001", 10);
const workdir = process.env.UPDATE_WORKDIR ?? "/workspace";
const stateDir = process.env.UPDATE_STATE_DIR ?? "/state";
const token = resolveUpdaterToken();
const projectDir = resolveHostProjectDir();
const remoteName = process.env.UPDATE_REMOTE ?? "origin";
const branchName = process.env.UPDATE_BRANCH ?? "main";
const expectedRepository =
  process.env.UPDATE_REPOSITORY_URL ??
  "https://github.com/a06342637/Email-reply.git";
const healthUrl =
  process.env.UPDATE_HEALTH_URL ?? "http://app:3000/health/ready";
const updaterVersion = process.env.APP_VERSION ?? "unknown";
const statePath = join(stateDir, "status.json");
const composeArgs = [
  "compose",
  "--project-directory",
  workdir,
  "-f",
  join(workdir, "compose.yml"),
];

if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("UPDATE_PORT is invalid");
if (token.length < 32)
  throw new Error("UPDATER_TOKEN must contain at least 32 characters");
if (!existsSync(join(workdir, ".git")))
  throw new Error("UPDATE_WORKDIR must contain a Git repository");
if (!isAbsolute(projectDir))
  throw new Error("UPDATE_PROJECT_DIR must be the absolute host project path");

mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const initialState: UpdateState = {
  phase: "IDLE",
  busy: false,
  progress: 0,
  currentVersion: readCurrentVersion(),
  latestVersion: null,
  updateAvailable: false,
  message: "可以检查新版本",
  checkedAt: null,
  startedAt: null,
  finishedAt: null,
  currentCommit: null,
  targetCommit: null,
  releaseNotes: [],
  blockedReason: null,
  backupFile: null,
  rollbackImage: null,
  error: null,
  logs: [],
  updaterVersion,
};

let state = loadState();
if (state.busy) {
  state = {
    ...state,
    phase: "FAILED",
    busy: false,
    error: "升级器在任务执行期间重启，请先检查当前应用健康状态再重新检查更新。",
    message: "上一次升级任务被意外中断",
    finishedAt: new Date().toISOString(),
    updaterVersion,
  };
  persistState();
}
let activeJob: Promise<void> | null = null;

function workspaceEnvValue(key: string): string {
  try {
    const env = readFileSync(join(workdir, ".env"), "utf8");
    return new RegExp(`^${key}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function resolveUpdaterToken(): string {
  const configured =
    process.env.UPDATER_TOKEN || workspaceEnvValue("UPDATER_TOKEN");
  if (configured) return configured;
  const instanceKey = workspaceEnvValue("INSTANCE_KEY");
  return instanceKey
    ? createHash("sha256")
        .update(`mailpilot-updater:${instanceKey}`)
        .digest("hex")
    : "";
}

function resolveHostProjectDir(): string {
  const configured = process.env.UPDATE_PROJECT_DIR ?? "";
  if (isAbsolute(configured)) return configured;
  const containerId = process.env.HOSTNAME ?? "";
  if (!containerId) return configured;
  try {
    return execFileSync(
      "docker",
      [
        "inspect",
        containerId,
        "--format",
        '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}',
      ],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
  } catch {
    return configured;
  }
}

function loadState(): UpdateState {
  if (!existsSync(statePath)) return initialState;
  try {
    const parsed = JSON.parse(
      readFileSync(statePath, "utf8"),
    ) as Partial<UpdateState>;
    return {
      ...initialState,
      ...parsed,
      currentVersion: readCurrentVersion(),
      updaterVersion,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-120) : [],
    };
  } catch {
    return initialState;
  }
}

function persistState(): void {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, statePath);
}

function updateState(patch: Partial<UpdateState>, log?: string): void {
  const safeLog = log ? sanitizeUpdaterLog(log) : "";
  state = {
    ...state,
    ...patch,
    updaterVersion,
    logs: safeLog ? [...state.logs, safeLog].slice(-120) : state.logs,
  };
  persistState();
}

function readCurrentVersion(): string {
  try {
    const env = readFileSync(join(workdir, ".env"), "utf8");
    const value = /^APP_VERSION=(.+)$/m.exec(env)?.[1]?.trim();
    if (value) return value;
  } catch {
    // Fall back to the checked-out VERSION file.
  }
  try {
    return readFileSync(join(workdir, "VERSION"), "utf8").trim();
  } catch {
    return updaterVersion;
  }
}

function writeCurrentVersion(version: string): void {
  const envPath = join(workdir, ".env");
  const source = readFileSync(envPath, "utf8");
  const mode = statSync(envPath).mode & 0o777;
  const temporary = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporary, replaceEnvValue(source, "APP_VERSION", version), {
    mode,
  });
  renameSync(temporary, envPath);
}

function authorized(req: IncomingMessage): boolean {
  const value = req.headers.authorization ?? "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function respond(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 16_384)
      throw new UpdaterError("REQUEST_TOO_LARGE", "请求内容过大", 413);
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
      string,
      unknown
    >;
  } catch {
    throw new UpdaterError("INVALID_JSON", "请求 JSON 格式无效");
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeUpdaterLog(message) || "未知升级错误";
}

async function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    allowedExitCodes?: number[];
    showProgress?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workdir,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let progressBuffer = "";
    let lastProgressAt = 0;
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout = (stdout + value).slice(-200_000);
      else stderr = (stderr + value).slice(-200_000);
      if (!options.showProgress) return;
      progressBuffer += value;
      const rows = progressBuffer.split(/\r?\n/);
      progressBuffer = rows.pop() ?? "";
      const latest = [...rows].reverse().map(sanitizeUpdaterLog).find(Boolean);
      if (latest && Date.now() - lastProgressAt >= 1_000) {
        lastProgressAt = Date.now();
        updateState({ message: latest }, latest);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", reject);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }, options.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const exitCode = code ?? -1;
      if ((options.allowedExitCodes ?? [0]).includes(exitCode))
        resolve({ stdout, stderr, code: exitCode });
      else {
        const detail = timedOut
          ? `${command} 执行超时`
          : sanitizeUpdaterLog(
              stderr.trim().split(/\r?\n/).at(-1) ||
                stdout.trim().split(/\r?\n/).at(-1) ||
                `${command} exited with ${exitCode}`,
            );
        reject(new Error(detail || `${command} 执行失败`));
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function git(args: string[], options?: Parameters<typeof run>[2]) {
  return run("git", args, { cwd: workdir, ...options });
}

async function docker(args: string[], options?: Parameters<typeof run>[2]) {
  return run("docker", args, { cwd: workdir, ...options });
}

async function compose(args: string[], options?: Parameters<typeof run>[2]) {
  return docker([...composeArgs, ...args], {
    ...options,
    env: composeVersionEnvironment(readCurrentVersion(), options?.env),
  });
}

async function discoverUpdate(): Promise<Discovery> {
  const remoteUrl = (
    await git(["remote", "get-url", remoteName])
  ).stdout.trim();
  if (
    normalizeRepositoryUrl(remoteUrl) !==
    normalizeRepositoryUrl(expectedRepository)
  )
    throw new UpdaterError(
      "UPDATE_REMOTE_MISMATCH",
      "Git 远程仓库与系统允许的官方仓库不一致，已拒绝在线升级",
      409,
    );

  await git(
    [
      "fetch",
      "--force",
      "--prune",
      "--prune-tags",
      "--tags",
      remoteName,
      `+refs/heads/${branchName}:refs/remotes/${remoteName}/${branchName}`,
    ],
    { timeoutMs: 120_000 },
  );
  const tags = (await git(["tag", "--list", "v[0-9]*.[0-9]*"])).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const latestTag = latestReleaseTag(tags);
  if (!latestTag)
    throw new UpdaterError(
      "NO_RELEASE_FOUND",
      "远程仓库没有可用的正式版本标签",
      502,
    );
  const latestVersion = releaseVersionFromTag(latestTag);
  if (latestTag !== `v${latestVersion}`)
    throw new UpdaterError(
      "RELEASE_TAG_INVALID",
      `正式版本标签 ${latestTag} 不符合 v0.07 格式，已拒绝升级`,
      502,
    );
  const currentVersion = readCurrentVersion();
  const currentCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const targetCommit = (
    await git(["rev-list", "-n", "1", latestTag])
  ).stdout.trim();
  const versionAtTarget = (
    await git(["show", `${targetCommit}:VERSION`])
  ).stdout.trim();
  if (versionAtTarget !== latestVersion)
    throw new UpdaterError(
      "RELEASE_VERSION_MISMATCH",
      `版本标签 ${latestTag} 与 VERSION 文件不一致，已拒绝升级`,
      502,
    );
  const reachable = await git(
    [
      "merge-base",
      "--is-ancestor",
      targetCommit,
      `${remoteName}/${branchName}`,
    ],
    { allowedExitCodes: [0, 1] },
  );
  if (reachable.code !== 0)
    throw new UpdaterError(
      "RELEASE_NOT_ON_BRANCH",
      `版本标签 ${latestTag} 不在 ${branchName} 主分支上，已拒绝升级`,
      502,
    );

  const branch = (await git(["branch", "--show-current"])).stdout.trim();
  const dirty = (
    await git(["status", "--porcelain", "--untracked-files=all"])
  ).stdout.trim();
  const forward = await git(
    ["merge-base", "--is-ancestor", currentCommit, targetCommit],
    { allowedExitCodes: [0, 1] },
  );
  let blockedReason: string | null = null;
  if (branch !== branchName)
    blockedReason = `当前 Git 分支是 ${branch || "detached HEAD"}，必须切换到 ${branchName}`;
  else if (dirty)
    blockedReason =
      "项目目录存在未提交文件改动；为防止覆盖本地文件，在线升级已锁定";
  else if (forward.code !== 0 && currentCommit !== targetCommit)
    blockedReason = "当前代码与正式版本历史不一致，不能执行快进升级";

  const updateAvailable =
    compareReleaseVersions(latestVersion, currentVersion) > 0;
  const releaseNotes = updateAvailable
    ? (
        await git([
          "log",
          "--format=%s",
          "--max-count=30",
          `${currentCommit}..${targetCommit}`,
        ])
      ).stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  return {
    currentVersion,
    latestVersion,
    latestTag,
    currentCommit,
    targetCommit,
    releaseNotes,
    updateAvailable,
    blockedReason,
  };
}

async function checkUpdate(): Promise<UpdateState> {
  if (activeJob || state.busy)
    throw new UpdaterError("UPDATE_BUSY", "已有升级任务正在运行", 409);
  updateState(
    {
      phase: "CHECKING",
      busy: true,
      progress: 2,
      message: "正在从官方仓库检查正式版本标签",
      error: null,
      blockedReason: null,
    },
    "开始检查更新",
  );
  try {
    const result = await discoverUpdate();
    updateState(
      {
        phase: result.updateAvailable ? "AVAILABLE" : "UP_TO_DATE",
        busy: false,
        progress: 100,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        updateAvailable: result.updateAvailable,
        message: result.updateAvailable
          ? `发现正式版本 v${result.latestVersion}`
          : "当前已经是最新正式版本",
        checkedAt: new Date().toISOString(),
        currentCommit: result.currentCommit,
        targetCommit: result.targetCommit,
        releaseNotes: result.releaseNotes,
        blockedReason: result.blockedReason,
      },
      result.updateAvailable
        ? `发现 v${result.latestVersion}`
        : "当前已是最新版本",
    );
    return state;
  } catch (error) {
    updateState(
      {
        phase: "FAILED",
        busy: false,
        progress: 0,
        message: "检查更新失败",
        error: safeError(error),
        finishedAt: new Date().toISOString(),
      },
      safeError(error),
    );
    throw error;
  }
}

async function createEncryptedBackup(passphrase: string): Promise<string> {
  const backupDir = join(workdir, "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const backupPath = join(backupDir, `pre-update-${stamp}.mpbak`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [...composeArgs, "exec", "-T", "app", "autoreply", "backup", "export"],
      { cwd: workdir, stdio: ["pipe", "pipe", "pipe"] },
    );
    const output = createWriteStream(backupPath, { mode: 0o600 });
    let stderr = "";
    let childCode: number | null = null;
    let outputFinished = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("升级前加密备份执行超时"));
    }, 600_000);
    const finish = () => {
      if (settled || childCode === null || !outputFinished) return;
      settled = true;
      clearTimeout(timer);
      if (childCode === 0) resolve();
      else
        reject(
          new Error(
            sanitizeUpdaterLog(
              stderr.trim().split(/\r?\n/).at(-1) || "升级前备份失败",
            ),
          ),
        );
    };
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    output.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(error);
      }
    });
    output.on("finish", () => {
      outputFinished = true;
      finish();
    });
    child.on("close", (code) => {
      childCode = code ?? -1;
      finish();
    });
    child.stdin.end(`${passphrase}\n`);
  }).catch((error) => {
    rmSync(backupPath, { force: true });
    throw error;
  });
  if (!existsSync(backupPath) || statSync(backupPath).size === 0) {
    rmSync(backupPath, { force: true });
    throw new Error("升级前备份为空，已停止升级");
  }
  chmodSync(backupPath, 0o600);
  return backupPath;
}

async function currentImage(service: "app" | "worker"): Promise<string> {
  const container = (await compose(["ps", "-q", service])).stdout.trim();
  if (!container) throw new Error(`找不到正在运行的 ${service} 容器`);
  return (
    await docker(["inspect", container, "--format", "{{.Image}}"])
  ).stdout.trim();
}

async function waitForReady(
  expectedVersion: string,
  timeoutMs = 240_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = "应用尚未就绪";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => null)) as {
        status?: string;
        version?: string;
      } | null;
      if (
        response.ok &&
        body?.status === "ready" &&
        body.version === expectedVersion
      )
        return;
      lastMessage = response.ok
        ? `健康检查版本为 ${body?.version || "未知"}，期望 ${expectedVersion}`
        : `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : lastMessage;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`新版本健康检查超时：${sanitizeUpdaterLog(lastMessage)}`);
}

async function scheduleUpdaterRefresh(): Promise<void> {
  const helperName = `mailpilot-updater-refresh-${randomUUID().slice(0, 8)}`;
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    helperName,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${projectDir}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    `APP_VERSION=${readCurrentVersion()}`,
    "-e",
    `UPDATER_APP_VERSION=${readCurrentVersion()}`,
    "microsoft-mail-autoreply-updater:local",
    "sh",
    "-lc",
    "sleep 4; docker compose --project-directory /workspace -f /workspace/compose.yml up -d --no-build --no-deps --force-recreate updater",
  ]);
}

async function rollback(
  oldCommit: string,
  oldVersion: string,
  rollbackImage: string | null,
  servicesTouched: boolean,
): Promise<boolean> {
  try {
    await git(["reset", "--hard", oldCommit], { timeoutMs: 30_000 });
    writeCurrentVersion(oldVersion);
    if (servicesTouched && rollbackImage) {
      await compose(
        [
          "up",
          "-d",
          "--no-build",
          "--no-deps",
          "--force-recreate",
          "app",
          "worker",
        ],
        {
          env: { AUTOREPLY_IMAGE: rollbackImage },
          timeoutMs: 120_000,
          showProgress: true,
        },
      );
      await waitForReady(oldVersion, 180_000);
    }
    return true;
  } catch (error) {
    updateState({}, `自动回滚失败：${safeError(error)}`);
    return false;
  }
}

async function applyUpdate(
  targetVersion: string,
  backupPassphrase: string,
): Promise<void> {
  let oldCommit = "";
  let oldVersion = readCurrentVersion();
  let rollbackImage: string | null = null;
  let servicesTouched = false;
  let workspaceChanged = false;
  try {
    updateState(
      {
        phase: "QUEUED",
        busy: true,
        progress: 1,
        currentVersion: oldVersion,
        latestVersion: targetVersion,
        updateAvailable: true,
        message: "升级任务已进入安全检查",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        backupFile: null,
        rollbackImage: null,
        error: null,
        logs: [],
      },
      `准备升级到 v${targetVersion}`,
    );
    const discovery = await discoverUpdate();
    oldCommit = discovery.currentCommit;
    oldVersion = discovery.currentVersion;
    if (!discovery.updateAvailable)
      throw new UpdaterError(
        "ALREADY_UP_TO_DATE",
        "当前已经是最新正式版本",
        409,
      );
    if (discovery.latestVersion !== targetVersion)
      throw new UpdaterError(
        "UPDATE_TARGET_CHANGED",
        `最新正式版本已经变为 v${discovery.latestVersion}，请重新确认升级`,
        409,
      );
    if (discovery.blockedReason)
      throw new UpdaterError(
        "UPDATE_PREFLIGHT_BLOCKED",
        discovery.blockedReason,
        409,
      );

    updateState(
      {
        phase: "BACKING_UP",
        progress: 8,
        message: "正在创建升级前加密备份",
        currentCommit: oldCommit,
        targetCommit: discovery.targetCommit,
        releaseNotes: discovery.releaseNotes,
      },
      "创建升级前加密备份",
    );
    const backupPath = await createEncryptedBackup(backupPassphrase);
    updateState(
      { backupFile: basename(backupPath), progress: 18 },
      `备份已生成：${basename(backupPath)}`,
    );

    const appImage = await currentImage("app");
    const workerImage = await currentImage("worker");
    if (appImage !== workerImage)
      throw new Error("app 与 worker 当前镜像不一致，已停止自动升级");
    rollbackImage = `microsoft-mail-autoreply:rollback-${Date.now()}`;
    await docker(["tag", appImage, rollbackImage]);
    updateState({ rollbackImage }, `已保留回滚镜像 ${rollbackImage}`);

    updateState(
      {
        phase: "PREPARING",
        progress: 24,
        message: `正在切换到正式版本 v${targetVersion}`,
      },
      "快进更新项目代码",
    );
    await git(["merge", "--ff-only", discovery.targetCommit], {
      timeoutMs: 60_000,
      showProgress: true,
    });
    writeCurrentVersion(targetVersion);
    workspaceChanged = true;

    updateState(
      {
        phase: "BUILDING",
        progress: 32,
        message: "正在构建新版本容器镜像，旧版本仍在运行",
      },
      "开始构建新镜像",
    );
    await compose(["build", "app", "worker", "migrate", "updater"], {
      timeoutMs: 1_800_000,
      showProgress: true,
    });

    updateState(
      {
        phase: "STOPPING",
        progress: 62,
        message: "正在短暂停止后台和 Worker",
      },
      "停止旧版本 app 与 worker",
    );
    servicesTouched = true;
    await compose(["stop", "app", "worker"], {
      timeoutMs: 120_000,
      showProgress: true,
    });

    updateState(
      {
        phase: "MIGRATING",
        progress: 70,
        message: "正在执行数据库迁移",
      },
      "执行数据库迁移",
    );
    await compose(["run", "--rm", "migrate"], {
      timeoutMs: 600_000,
      showProgress: true,
    });

    updateState(
      {
        phase: "STARTING",
        progress: 80,
        message: "正在启动新版本后台和 Worker",
      },
      "启动新版本服务",
    );
    await compose(
      [
        "up",
        "-d",
        "--no-build",
        "--no-deps",
        "--force-recreate",
        "app",
        "worker",
      ],
      { timeoutMs: 180_000, showProgress: true },
    );

    updateState(
      {
        phase: "HEALTH_CHECK",
        progress: 90,
        message: "正在验证数据库、Redis、后台与 Worker 健康状态",
      },
      "等待新版本健康检查",
    );
    await waitForReady(targetVersion);

    updateState(
      {
        phase: "SUCCEEDED",
        busy: false,
        progress: 100,
        currentVersion: targetVersion,
        latestVersion: targetVersion,
        updateAvailable: false,
        message: `已成功升级到 v${targetVersion}`,
        checkedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        blockedReason: null,
        error: null,
      },
      `v${targetVersion} 健康检查通过`,
    );
    await scheduleUpdaterRefresh().catch((error) =>
      updateState({}, `升级器容器延迟刷新失败：${safeError(error)}`),
    );
  } catch (error) {
    const failure = safeError(error);
    const rollbackNeeded =
      Boolean(oldCommit) && (workspaceChanged || servicesTouched);
    const restored = rollbackNeeded
      ? await rollback(oldCommit, oldVersion, rollbackImage, servicesTouched)
      : true;
    updateState(
      {
        phase: rollbackNeeded && restored ? "ROLLED_BACK" : "FAILED",
        busy: false,
        progress: 100,
        currentVersion: readCurrentVersion(),
        updateAvailable: true,
        message: rollbackNeeded
          ? restored
            ? "升级失败，系统已自动恢复到升级前版本"
            : "升级和自动回滚均失败，需要服务器管理员处理"
          : "升级在切换版本前失败，当前运行版本未发生变化",
        error: failure,
        finishedAt: new Date().toISOString(),
      },
      failure,
    );
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://updater.local");
    if (req.method === "GET" && url.pathname === "/health/live") {
      respond(res, 200, { status: "live", version: updaterVersion });
      return;
    }
    if (!authorized(req)) {
      respond(res, 401, { error: { code: "UNAUTHORIZED", message: "未授权" } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/status") {
      state = {
        ...state,
        currentVersion: state.busy
          ? state.currentVersion
          : readCurrentVersion(),
        updaterVersion,
      };
      respond(res, 200, state as unknown as Record<string, unknown>);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/check") {
      respond(
        res,
        200,
        (await checkUpdate()) as unknown as Record<string, unknown>,
      );
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/apply") {
      if (activeJob || state.busy)
        throw new UpdaterError("UPDATE_BUSY", "已有升级任务正在运行", 409);
      const body = await readJson(req);
      const targetVersion = String(body.targetVersion ?? "").trim();
      const backupPassphrase = String(body.backupPassphrase ?? "");
      if (!/^\d+\.\d+$/.test(targetVersion))
        throw new UpdaterError("TARGET_VERSION_INVALID", "目标版本格式无效");
      if (backupPassphrase.length < 12 || backupPassphrase.length > 256)
        throw new UpdaterError(
          "BACKUP_PASSPHRASE_INVALID",
          "升级前备份口令必须为 12–256 位",
        );
      if (body.confirmation !== "UPGRADE")
        throw new UpdaterError(
          "UPDATE_CONFIRMATION_REQUIRED",
          "必须确认升级操作",
        );
      updateState({ phase: "QUEUED", busy: true, progress: 0 });
      activeJob = applyUpdate(targetVersion, backupPassphrase).finally(() => {
        activeJob = null;
      });
      respond(res, 202, {
        accepted: true,
        targetVersion,
        phase: "QUEUED",
      });
      return;
    }
    respond(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
  } catch (error) {
    const known = error instanceof UpdaterError;
    respond(res, known ? error.status : 500, {
      error: {
        code: known ? error.code : "UPDATER_INTERNAL_ERROR",
        message: safeError(error),
      },
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MailPilot updater listening on 0.0.0.0:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
