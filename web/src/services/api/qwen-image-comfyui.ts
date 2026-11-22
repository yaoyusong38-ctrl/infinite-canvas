import i18n from "@/i18n";
import { blobToDataUrl, imageToDataUrl } from "@/services/image-storage";
import { withLocalProxy } from "@/stores/use-config-store";
import type { QwenImageTask, ReferenceImage } from "@/types/image";
import { createPoll } from "./model-plugin";

type PromptNode = { class_type: string; inputs: Record<string, unknown> };
type OutputImage = { filename: string; subfolder: string; type: string };
type ComfyJob = {
    status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
    outputs?: { output?: { images?: OutputImage[] } };
    execution_error?: { exception_message?: string };
};

export type QwenImageRequestOptions = {
    signal?: AbortSignal;
    onQwenTask?: (task: QwenImageTask | undefined, id: string) => void | Promise<void>;
};

export const STOP_QWEN_IMAGE = Symbol("stop Qwen image");

class ComfyTaskFailed extends Error {}

function comfyUrl(baseUrl: string, path: string) {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(base)) throw new ComfyTaskFailed(i18n.t("canvas.qwen.localAddress"));
    return withLocalProxy(base + path);
}

function jobPath(task: QwenImageTask) {
    return "/api/jobs/" + encodeURIComponent(task.id);
}

async function withTaskState<T>(task: QwenImageTask, options: QwenImageRequestOptions, action: (report: (state: QwenImageTask["state"]) => Promise<void>) => Promise<T>) {
    const { signal, onQwenTask } = options;
    let state = task.state;
    const report = async (next: QwenImageTask["state"]) => {
        if (state === next) return;
        state = next;
        await onQwenTask?.({ ...task, state }, task.id);
    };
    try {
        return await action(report);
    } catch (error) {
        if (signal?.aborted && signal.reason === STOP_QWEN_IMAGE) {
            // The endpoint cancels only the requested pending or running job.
            const response = await fetch(comfyUrl(task.baseUrl, jobPath(task) + "/cancel"), { method: "POST" }).catch(() => null);
            const result = response?.ok ? await response.json().catch(() => null) as { cancelled?: boolean } | null : null;
            if (result?.cancelled) await onQwenTask?.(undefined, task.id);
            else await report("waiting");
            throw new DOMException(i18n.t("common.requestCanceled"), "AbortError");
        }
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (error instanceof Error && error.name === "ModelPollTimeout") {
            await report("timeout");
            throw new Error(i18n.t("canvas.qwen.timeout"));
        }
        if (error instanceof ComfyTaskFailed) await onQwenTask?.(undefined, task.id);
        else await report("waiting");
        throw error;
    }
}

async function waitForOutput(task: QwenImageTask, report: (state: QwenImageTask["state"]) => Promise<void>, signal?: AbortSignal) {
    let knownToComfy = task.state !== "submitting";
    const output = await createPoll(signal)(async () => {
        const response = await fetch(comfyUrl(task.baseUrl, jobPath(task)), { signal });
        if (response.status === 404) {
            // A reload can arrive while ComfyUI is still validating the original submission.
            if (!knownToComfy) return null;
            throw new ComfyTaskFailed(i18n.t("canvas.qwen.notFound"));
        }
        if (!response.ok) throw new Error(i18n.t("canvas.qwen.connectionFailed", { status: response.status }));
        const job: ComfyJob = await response.json();
        knownToComfy = true;
        if (job.status === "pending") await report("queued");
        if (job.status === "in_progress") await report("running");
        if (job.status === "cancelled") throw new ComfyTaskFailed(i18n.t("common.requestCanceled"));
        if (job.status === "failed") throw new ComfyTaskFailed(job.execution_error?.exception_message || i18n.t("canvas.qwen.failed"));
        if (job.status !== "completed") return null;
        const image = job.outputs?.output?.images?.[0];
        if (!image) throw new ComfyTaskFailed(i18n.t("canvas.qwen.noImage"));
        return image;
    }, (result) => result);
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type });
    const response = await fetch(comfyUrl(task.baseUrl, "/view?" + query), { signal });
    if (!response.ok) throw new Error(i18n.t("canvas.qwen.connectionFailed", { status: response.status }));
    return response.blob();
}

export function resumeQwenImageTask(task: QwenImageTask, options: QwenImageRequestOptions = {}) {
    return withTaskState(task, options, (report) => waitForOutput(task, report, options.signal));
}

export async function requestQwenImages(baseUrl: string, prompt: string, images: ReferenceImage[], size: string | undefined, count: number, options: QwenImageRequestOptions = {}) {
    const { signal, onQwenTask } = options;
    const [width, height] = (size || "1024x1024").split("x").map(Number);
    const resolution = images.length ? Math.round(Math.sqrt(width * height) / 32) * 32 : 1024;
    const graph: Record<string, PromptNode> = {
        unet: { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1\\qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
        clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
        vae: { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
        encode: { class_type: "TextEncodeQwenImage21", inputs: { clip: ["clip", 0], vae: ["vae", 0], prompt, negative_prompt: "", resolution } },
        cache: { class_type: "QwenImage21Cache", inputs: { model: ["unet", 0], device: "auto", dtype: "default" } },
        sampler: { class_type: "KSampler", inputs: { model: ["cache", 0], positive: ["encode", 0], negative: ["encode", 1], latent_image: ["encode", 2], seed: 0, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["vae", 0] } },
        output: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "InfiniteCanvas/Qwen-Image-2.1-INT8" } },
    };
    if (images.length) {
        if (images.length > 16) throw new Error(i18n.t("canvas.qwen.referenceLimit"));
        for (const [index, image] of images.entries()) {
            const blob = await (await fetch(await imageToDataUrl(image, { signal }), { signal })).blob();
            const form = new FormData();
            const extension = blob.type.match(/^image\/([a-z0-9]+)/i)?.[1] || "png";
            form.append("image", blob, `canvas-${crypto.randomUUID()}.${extension}`);
            const response = await fetch(comfyUrl(baseUrl, "/upload/image"), { method: "POST", body: form, signal });
            if (!response.ok) throw new Error(i18n.t("canvas.qwen.connectionFailed", { status: response.status }));
            const file: { subfolder?: string; name: string } = await response.json();
            const node = "reference_" + (index + 1);
            graph[node] = { class_type: "LoadImage", inputs: { image: [file.subfolder, file.name].filter(Boolean).join("/") } };
            graph.encode.inputs["images.image_" + (index + 1)] = [node, 0];
        }
    } else if (size) {
        // LatentUpscale uses 8 pixels per latent cell and this model decodes 16.
        graph.resize = { class_type: "LatentUpscale", inputs: { samples: ["encode", 2], width: Math.round(width / 32) * 16, height: Math.round(height / 32) * 16, upscale_method: "nearest-exact", crop: "disabled" } };
        graph.sampler.inputs.latent_image = ["resize", 0];
    }

    const results: { id: string; dataUrl: string }[] = [];
    const url = comfyUrl(baseUrl, "/prompt");
    for (let index = 0; index < count; index++) {
        const task: QwenImageTask = { id: crypto.randomUUID(), baseUrl, state: "submitting" };
        graph.sampler.inputs.seed = crypto.getRandomValues(new Uint32Array(1))[0];
        await onQwenTask?.(task, task.id);
        if (signal?.aborted) {
            await onQwenTask?.(undefined, task.id);
            throw new DOMException("Aborted", "AbortError");
        }
        const blob = await withTaskState(task, options, async (report) => {
            // Wait for the submission receipt so a stop can cancel the accepted ID.
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: graph, prompt_id: task.id }),
            });
            if (!response.ok) {
                const result = await response.json().catch(() => null) as { error?: { message?: string; details?: string } } | null;
                const message = result?.error?.details || result?.error?.message || i18n.t("canvas.qwen.connectionFailed", { status: response.status });
                if (response.status >= 400 && response.status < 500) throw new ComfyTaskFailed(message);
                throw new Error(message);
            }
            const receipt: { prompt_id?: string } = await response.json();
            if (receipt.prompt_id !== task.id) throw new Error(i18n.t("canvas.qwen.receipt"));
            return waitForOutput(task, report, signal);
        });
        results.push({ id: task.id, dataUrl: await blobToDataUrl(blob) });
    }
    return results;
}
