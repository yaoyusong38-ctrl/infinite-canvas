import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { flushSync } from "react-dom";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import i18n from "@/i18n";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { resumeQwenImageTask, type QwenImageRequestOptions } from "@/services/api/qwen-image-comfyui";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { flushCanvasStorage, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";

export function applyGeneratedImage(node: CanvasNodeData, imageId: string, uploaded: UploadedImage): CanvasNodeData {
    const item: CanvasNodeImage = {
        id: imageId,
        status: "success",
        content: uploaded.url,
        storageKey: uploaded.storageKey,
        naturalWidth: uploaded.width,
        naturalHeight: uploaded.height,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
    };
    const images = node.metadata?.images?.map((image) => image.id === imageId ? item : image) || [];
    if (node.metadata?.primaryImageId && node.metadata.primaryImageId !== imageId) return { ...node, metadata: { ...node.metadata, images } };
    const maxSize = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = fitNodeSize(uploaded.width, uploaded.height, maxSize.width, maxSize.height);
    return {
        ...node,
        ...size,
        position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 },
        metadata: { ...node.metadata, ...imageMetadata(uploaded), status: node.metadata?.status, images, primaryImageId: imageId },
    };
}

export function useCanvasQwenTasks(projectId: string, nodesRef: RefObject<CanvasNodeData[]>, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    const active = useRef(true);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, [projectId]);

    const trackQwenTask = useCallback((nodeId: string, imageId: string): NonNullable<QwenImageRequestOptions["onQwenTask"]> => async (task, id) => {
        if (!active.current) {
            if (task?.state === "submitting") throw new DOMException("Aborted", "AbortError");
            return;
        }
        const submitting = task?.state === "submitting";
        const update = () => setNodes((nodes) => nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const images = node.metadata?.images || [];
            const slot = images.find((image) => image.id === imageId);
            if (!submitting && slot?.qwenTask?.id !== id) return node;
            const next = { ...(slot || { id: imageId, status: "loading" as const, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }), qwenTask: task };
            return { ...node, metadata: { ...node.metadata, images: slot ? images.map((image) => image.id === imageId ? next : image) : [...images, next] } };
        }));
        if (!submitting) {
            update();
            return;
        }

        // Persist the job ID before submission so a refresh can recover the result.
        flushSync(update);
        const project = useCanvasStore.getState().openProject(projectId);
        const current = nodesRef.current.find((node) => node.id === nodeId);
        if (!project || !current?.metadata?.images?.some((image) => image.qwenTask?.id === id)) throw new DOMException("Aborted", "AbortError");
        if (project.nodes !== nodesRef.current) useCanvasStore.getState().updateProject(projectId, { nodes: nodesRef.current });
        await flushCanvasStorage();
    }, [nodesRef, projectId, setNodes]);

    const resumeQwenImages = useCallback(async (node: CanvasNodeData, signal: AbortSignal, imageId?: string) => {
        const tasks = node.metadata?.images?.flatMap((image) => image.qwenTask && (!imageId || image.id === imageId) ? [{ slotId: image.id, task: image.qwenTask }] : []) || [];
        const slotIds = new Set(tasks.map(({ slotId }) => slotId));
        setNodes((nodes) => nodes.map((item) => item.id === node.id ? { ...item, metadata: {
            ...item.metadata,
            status: "loading",
            errorDetails: undefined,
            images: item.metadata?.images?.map((image) => slotIds.has(image.id) ? { ...image, status: "loading", errorDetails: undefined } : image),
        } } : item));

        await Promise.all(tasks.map(async ({ slotId, task }) => {
            try {
                const blob = await resumeQwenImageTask(task, { signal, onQwenTask: trackQwenTask(node.id, slotId) });
                const image = await uploadImage(blob, { signal });
                if (signal.aborted) return;
                setNodes((nodes) => nodes.map((item) => item.id === node.id && item.metadata?.images?.find((slot) => slot.id === slotId)?.qwenTask?.id === task.id
                    ? applyGeneratedImage(item, slotId, image) : item));
            } catch (error) {
                if (signal.aborted) return;
                const errorDetails = error instanceof Error ? error.message : i18n.t("canvas.qwen.failed");
                setNodes((nodes) => nodes.map((item) => item.id === node.id ? { ...item, metadata: {
                    ...item.metadata,
                    images: item.metadata?.images?.map((image) => image.id === slotId ? { ...image, status: "error", errorDetails } : image),
                } } : item));
            }
        }));
        if (signal.aborted) return;
        setNodes((nodes) => nodes.map((item) => {
            if (item.id !== node.id) return item;
            const images = item.metadata?.images || [];
            const status = images.some((image) => image.status === "loading") ? "loading" : images.some((image) => image.content) || item.metadata?.content ? "success" : "error";
            const errorDetails = status === "error" ? images.find((image) => image.errorDetails)?.errorDetails : undefined;
            return { ...item, metadata: { ...item.metadata, status, errorDetails } };
        }));
    }, [setNodes, trackQwenTask]);

    return { trackQwenTask, resumeQwenImages };
}
