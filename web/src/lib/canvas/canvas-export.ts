import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip, readZip } from "@/lib/zip";
import { collectMediaStorageKeys, getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missing = new Set<string>();
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                Array.from(collectMediaStorageKeys(project), async (storageKey) => {
                    const blob = await readStoredAsset(storageKey).catch(() => null);
                    if (!blob?.size) {
                        missing.add(storageKey);
                        return;
                    }
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    if (missing.size) throw missingAssets(missing);
    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

function readStoredAsset(storageKey: string) {
    return storageKey.startsWith("image:") ? getImageBlob(storageKey) : getMediaBlob(storageKey);
}

function missingAssets(files: Set<string>) {
    return new Error(i18n.t("canvas.archive.assetsMissing", { files: [...files].join("、") }));
}

async function sameAsset(first: Blob, second: Blob) {
    if (first.size !== second.size) return false;
    const [firstBuffer, secondBuffer] = await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
    const right = new Uint8Array(secondBuffer);
    return new Uint8Array(firstBuffer).every((byte, index) => byte === right[index]);
}

export async function readCanvasProjectArchive(file: Blob) {
    const zip = await readZip(file);
    const projectFile = zip.get("projects.json");
    const invalidArchive = () => new Error(i18n.t("canvas.importFailed"));
    if (!projectFile) throw invalidArchive();
    const data: CanvasExportFile = await projectFile.text().then(JSON.parse).catch(() => { throw invalidArchive(); });
    if (data?.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects)) throw invalidArchive();

    const assets = new Map<string, Blob>();
    const missing = new Set<string>();
    for (const item of data.projects) {
        if (!item?.project || !Array.isArray(item.project.nodes) || !Array.isArray(item.project.connections) || !Array.isArray(item.files)) throw invalidArchive();
        const keys = new Set<string>();
        for (const entry of item.files) {
            if (typeof entry?.storageKey !== "string" || typeof entry.path !== "string" || typeof entry.mimeType !== "string") throw invalidArchive();
            keys.add(entry.storageKey);
            const blob = zip.get(entry.path);
            if (!blob?.size || blob.size !== entry.bytes) {
                missing.add(entry.path);
                continue;
            }
            const previous = assets.get(entry.storageKey);
            if (previous && !(await sameAsset(previous, blob))) throw new Error(i18n.t("canvas.archive.assetConflict", { file: entry.path }));
            if (!previous) assets.set(entry.storageKey, blob.slice(0, blob.size, entry.mimeType));
        }
        for (const key of collectMediaStorageKeys(item.project)) {
            if (!keys.has(key)) missing.add(key);
        }
    }
    if (missing.size) throw missingAssets(missing);

    // Preflight shared storage keys before writing any asset or creating projects.
    const writes = await Promise.all(Array.from(assets, async ([key, blob]) => {
        const previous = await readStoredAsset(key);
        if (previous && !(await sameAsset(previous, blob))) throw new Error(i18n.t("canvas.archive.assetConflict", { file: key }));
        return previous ? null : { key, blob };
    }));
    await Promise.all(writes.map((entry) => {
        if (!entry) return;
        return entry.key.startsWith("image:") ? setImageBlob(entry.key, entry.blob) : setMediaBlob(entry.key, entry.blob);
    }));
    return data.projects.map(({ project }) => project);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
