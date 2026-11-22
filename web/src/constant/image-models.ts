export const QWEN_IMAGE_COMFYUI_CHANNEL_ID = "qwen-image-comfyui";
export const QWEN_IMAGE_INT8_MODEL = "Qwen-Image-2.1 INT8 ConvRot";

export function isQwenImagePreset(model: string, script?: string) {
    if (model !== `${QWEN_IMAGE_COMFYUI_CHANNEL_ID}::${QWEN_IMAGE_INT8_MODEL}`) return false;
    // Existing presets store the original script. A separately authored script still takes precedence.
    return !script || (script.startsWith("const endpoint = (path)") && script.includes('filename_prefix: "InfiniteCanvas/Qwen-Image-2.1-INT8"'));
}
