import type { Field, FieldName, Item } from "./types";
import { isTagId } from "./taxonomy";

type BackendField = {
  value: unknown;
  state: "suggested" | "confirmed";
  by: "rule" | "embedding" | "model" | "user";
  model?: string;
  confidence?: number;
  at: string;
};

type BackendView = {
  status: "pending" | "processed";
  item: { title?: string; savedAt: string };
  extraction?: { title?: string } | null;
  fields?: Partial<Record<string, BackendField>>;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/categoriser/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Categoriser request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function base64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  });
}

export async function submitToCategoriser(item: Item, projectName: string | undefined, blob?: Blob): Promise<BackendView> {
  let file: { name: string; mime: string; bytes: string } | undefined;
  if (item.attachment && blob && (item.attachment.mime.startsWith("image/") || item.attachment.mime === "application/pdf")) {
    file = { name: item.attachment.name, mime: item.attachment.mime, bytes: await base64(blob) };
  }
  const text = [item.rawContent, item.whyISavedThis, item.attachment && !file ? `Saved file: ${item.attachment.name}` : undefined]
    .filter(Boolean).join("\n\n");
  await api<{ itemId: string }>("items", {
    method: "POST",
    body: JSON.stringify({
      id: item.id,
      savedAt: item.createdAt,
      userId: "local",
      ...(item.url ? { url: item.url } : {}),
      ...(text ? { text } : {}),
      ...(file ? { file } : {}),
      ...(projectName ? { currentProject: projectName } : {}),
      localOnly: false,
      visionOptIn: false,
    }),
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const view = await api<BackendView>(`items/${encodeURIComponent(item.id)}`);
    if (view.status === "processed") return view;
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  throw new Error("Categoriser is still processing. Try again in a moment.");
}

export async function syncReview(itemId: string, name: FieldName, action: "confirm" | "reject"): Promise<void> {
  const backendName = name === "collection" ? "project" : name;
  await api(`items/${encodeURIComponent(itemId)}/fields/${backendName}/${action}`, { method: "POST", body: "{}" });
}

export function mapBackendFields(view: BackendView, collections: { id: string; name: string }[]): Partial<Record<FieldName, Field<unknown>>> {
  const output: Partial<Record<FieldName, Field<unknown>>> = {};
  const map: Array<[FieldName, string]> = [
    ["type", "type"], ["source", "source"], ["tags", "tags"], ["oneLineSummary", "oneLineSummary"], ["collection", "project"],
  ];
  for (const [name, backendName] of map) {
    const source = view.fields?.[backendName];
    if (!source) continue;
    let value = source.value;
    if (name === "tags") {
      value = Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string" && isTagId(tag)) : [];
    }
    if (name === "collection") {
      const project = Array.isArray(value) ? (value[0] as { project?: unknown } | undefined)?.project : undefined;
      const found = typeof project === "string" ? collections.find((collection) => collection.name.toLocaleLowerCase() === project.toLocaleLowerCase()) : undefined;
      value = found?.id ?? null;
    }
    output[name] = {
      value,
      state: "suggested",
      by: source.by,
      ...(source.model ? { model: source.model } : {}),
      ...(typeof source.confidence === "number" ? { confidence: source.confidence } : {}),
      at: source.at,
    } as Field<unknown>;
  }
  return output;
}
