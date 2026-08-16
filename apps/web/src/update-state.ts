export const UPDATE_PENDING_VERSION_KEY = "autoreply:update-pending-version";

export function isFinishedUpdatePhase(phase: string | undefined): boolean {
  return ["SUCCEEDED", "FAILED", "ROLLED_BACK"].includes(phase ?? "");
}

export function shouldReloadAfterUpdate(
  phase: string | undefined,
  currentVersion: string | undefined,
  pendingVersion: string | null,
): boolean {
  return (
    phase === "SUCCEEDED" &&
    Boolean(pendingVersion) &&
    currentVersion === pendingVersion
  );
}
