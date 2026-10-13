export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) throw Error(data.error ?? "Request failed");
  return data;
}

export const STATUS_LABELS: Record<string, string> = {
  starting: "Detected",
  investigating: "Investigating",
  root_cause_found: "Root cause found",
  fix_in_progress: "Fixing",
  ready_for_review: "Ready for review",
  deployed: "Deployed",
  blocked: "Blocked",
};
