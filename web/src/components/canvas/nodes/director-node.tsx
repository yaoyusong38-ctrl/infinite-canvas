import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ExternalLink, X } from "lucide-react";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { getNodeSpec } from "@/lib/canvas/node-registry";
import type { CanvasNodeContext, CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

const editorOrigin = "http://127.0.0.1:4318";
const connectionLabels = { idle: "未连接", opening: "正在连接", online: "已连接", offline: "无法连接，请启动本地导演台后重试" };

export function directorResource(node: CanvasNodeData): CanvasNodeResource | null {
    const metadata = node.metadata;
    if (metadata?.directorVideoStorageKey) return { kind: "video", storageKey: metadata.directorVideoStorageKey, mimeType: metadata.directorVideoMimeType };
    if (metadata?.directorThumbnailStorageKey) return { kind: "image", storageKey: metadata.directorThumbnailStorageKey, mimeType: "image/png" };
    return null;
}

function DirectorContent({ ctx }: { ctx: CanvasNodeContext }) {
    const [open, setOpen] = useState(false);
    const [error, setError] = useState("");
    const [connection, setConnection] = useState<keyof typeof connectionLabels>("idle");
    const [pending, setPending] = useState(0);
    const [saved, setSaved] = useState(false);
    const [waitingForVideo, setWaitingForVideo] = useState(false);
    const [thumbnail, setThumbnail] = useState("");
    const frame = useRef<HTMLIFrameElement>(null);
    const deliveryQueue = useRef(Promise.resolve());
    const pendingDeliveries = useRef(0);
    const context = useRef(ctx);
    context.current = ctx;
    const projectId = ctx.node.metadata?.directorProjectId;
    const editorUrl = `${editorOrigin}/?project_id=${encodeURIComponent(projectId || "")}&canvas_origin=${encodeURIComponent(window.location.origin)}`;
    const closeEditor = () => {
        setOpen(false);
        setConnection("idle");
    };

    useEffect(() => {
        let cancelled = false;
        resolveImageUrl(ctx.node.metadata?.directorThumbnailStorageKey || ctx.node.metadata?.storageKey).then((url) => { if (!cancelled) setThumbnail(url); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [ctx.node.metadata?.directorThumbnailStorageKey, ctx.node.metadata?.storageKey]);

    useEffect(() => {
        if (!open || !projectId) return;
        const sendInputs = async () => {
            const current = context.current;
            const inputs = await Promise.all(current.getUpstream().map(async (node) => {
                const metadata = node.metadata;
                if (node.type === "text") return { id: node.id, title: node.title, kind: "text", text: metadata?.content || metadata?.prompt || "" };
                if (node.type === "image" && (metadata?.content || metadata?.storageKey)) {
                    return { id: node.id, title: node.title, kind: "image", dataUrl: await imageToDataUrl({ url: metadata?.content, storageKey: metadata?.storageKey }) };
                }
                return null;
            }));
            frame.current?.contentWindow?.postMessage({ type: "director:inputs", projectId, inputs: inputs.filter(Boolean) }, editorOrigin);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== editorOrigin || event.source !== frame.current?.contentWindow || event.data?.projectId !== projectId) return;
            if (event.data.type === "director:ready") {
                setConnection("online");
                void sendInputs().catch((reason) => setError(`发送画布输入失败：${String(reason)}`));
            }
            if (event.data.type === "director:close") closeEditor();
            const payload = event.data;
            if (!["director:still", "director:video", "director:data"].includes(payload.type)) return;
            if (payload.type === "director:data") setWaitingForVideo(true);
            if (payload.type === "director:video") setWaitingForVideo(false);
            if (pendingDeliveries.current === 0 && payload.type !== "director:video") setError("");
            setPending(++pendingDeliveries.current);
            deliveryQueue.current = deliveryQueue.current.then(async () => {
                const summary = { directorUpdatedAt: payload.updatedAt, directorShotCount: payload.shotCount, directorDurationSec: payload.durationSec };
                const commit = async (kind: "still" | "video" | "data", metadata: CanvasNodeMetadata, patch?: CanvasNodeMetadata) => {
                    const current = context.current;
                    const parent = current.getNode(current.node.id);
                    if (parent?.metadata?.directorProjectId !== projectId) throw new Error("导演台节点已移除或更换工程");
                    const id = `director-${kind}-${crypto.randomUUID()}`;
                    const [nodeType, title, offset] = ({
                        still: ["image", "导演台机位截图", 0],
                        video: ["video", "导演台预演视频", parent.height + 40],
                        data: ["text", "导演台镜头数据 JSON", parent.height * 2 + 80],
                    } as const)[kind];
                    const { width, height } = getNodeSpec(nodeType);
                    const y = parent.position.y + offset;
                    let x = parent.position.x + parent.width + 80;
                    const gap = 24;
                    const blockers = current.getNodes()
                        .filter((node) => node.position.y < y + height + gap && node.position.y + node.height + gap > y)
                        .sort((a, b) => a.position.x - b.position.x);
                    for (const node of blockers) {
                        const right = node.position.x + node.width + gap;
                        if (right > x && node.position.x < x + width + gap) x = right;
                    }
                    await current.commitOps([
                        { type: "add_node", id, nodeType, title, x, y, metadata: { ...metadata, status: "success" } },
                        { type: "connect_nodes", fromNodeId: parent.id, toNodeId: id },
                        ...(patch ? [{ type: "update_node" as const, id: parent.id, metadata: { ...summary, ...patch } }] : []),
                    ]);
                };
                if (payload.type === "director:still") {
                    if (typeof payload.dataUrl !== "string" || !payload.dataUrl.startsWith("data:image/png;base64,")) throw new Error("无效的 PNG 截图");
                    const image = await uploadImage(payload.dataUrl);
                    await commit("still", imageMetadata(image), { ...imageMetadata(image), directorThumbnailStorageKey: image.storageKey });
                } else if (payload.type === "director:video") {
                    if (typeof payload.videoBase64 !== "string") throw new Error("无效的 MP4 视频");
                    const bytes = Uint8Array.from(atob(payload.videoBase64), (char) => char.charCodeAt(0));
                    const video = await uploadMediaFile(new Blob([bytes], { type: payload.videoMimeType || "video/mp4" }), "director-video");
                    await commit("video", videoMetadata(video), { directorVideoStorageKey: video.storageKey, directorVideoMimeType: video.mimeType });
                } else {
                    const data = payload.data;
                    if (data?.schema !== "kunpeng-director-canvas/v1" || data.project?.id !== projectId || data.manifest?.projectId !== projectId) throw new Error("无效的镜头数据");
                    await commit("data", { content: JSON.stringify(data, null, 2) });
                }
                setSaved(true);
            }).catch((reason) => setError(`回传保存失败：${String(reason)}`)).finally(() => setPending(--pendingDeliveries.current));
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [open, projectId]);

    const openEditor = async () => {
        if (connection === "opening") return;
        setConnection("opening");
        setError("");
        setWaitingForVideo(false);
        try {
            // The local service restricts CORS. The frame handshake confirms the connection.
            await fetch(`${editorOrigin}/api/health`, { mode: "no-cors", cache: "no-store" });
        } catch {
            setConnection("offline");
            return;
        }
        try {
            if (!projectId) await ctx.commitOps([{ type: "update_node", id: ctx.node.id, metadata: { directorProjectId: `director-${crypto.randomUUID()}` } }]);
            setOpen(true);
        } catch (reason) {
            setConnection("idle");
            setError(`保存导演台工程失败：${String(reason)}`);
        }
    };
    const status = error || (pending ? "正在接收并保存…" : waitingForVideo ? "等待预演视频回传…" : saved || ctx.node.metadata?.directorThumbnailStorageKey || ctx.node.metadata?.directorVideoStorageKey ? "已保存" : "");

    return <div data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", color: ctx.theme.node.text }}>
        <button type="button" onClick={openEditor} onPointerDown={(event) => event.stopPropagation()} style={{ flex: 1, minHeight: 0, display: "grid", placeItems: "center", padding: 0, border: 0, background: ctx.theme.node.panel, color: "inherit", cursor: "pointer", overflow: "hidden" }}>
            {thumbnail ? <img src={thumbnail} alt="当前机位构图" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <Camera size={36} strokeWidth={1.3} />}
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", fontSize: 12 }}>
            <span>{ctx.node.metadata?.directorShotCount || 0} 个镜头 · {ctx.node.metadata?.directorDurationSec || 0} 秒</span>
            <button type="button" title="打开导演台" onClick={openEditor} onPointerDown={(event) => event.stopPropagation()} style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer" }}><ExternalLink size={16} /></button>
        </div>
        <div role="status" title={status || undefined} className="px-3 pb-2 text-xs" style={{ color: ctx.theme.node.muted }}>
            {connectionLabels[connection]}{status && <div className="truncate">{status}</div>}
        </div>
        {open && projectId && createPortal(<div role="dialog" aria-modal="true" aria-label="3D 导演台" onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} style={{ position: "fixed", inset: 0, zIndex: 1500, display: "flex", flexDirection: "column", background: ctx.theme.node.panel, color: ctx.theme.node.text }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderBottom: `1px solid ${ctx.theme.node.stroke}` }}>
                <Camera size={18} /><strong style={{ flex: 1 }}>3D 导演台</strong>
                <span role="status">{status || connectionLabels[connection]}</span>
                <button type="button" title="返回画布" aria-label="返回画布" onClick={closeEditor} style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer" }}><X size={20} /></button>
            </div>
            <iframe ref={frame} title="3D 导演台编辑器" src={editorUrl} style={{ flex: 1, width: "100%", border: 0 }} />
        </div>, document.body)}
    </div>;
}

export const directorNodeDefinition: CanvasNodeDefinition = {
    type: "kunpeng-director:director",
    title: "3D 导演台",
    icon: <Camera size={16} />,
    defaultSize: { width: 360, height: 250 },
    defaultMetadata: {},
    hidePanel: true,
    resource: directorResource,
    Content: DirectorContent,
};
